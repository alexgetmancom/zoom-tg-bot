import { Bot, InlineKeyboard } from "grammy";
import type { InlineQueryResultArticle, InputTextMessageContent } from "grammy/types";
import type { AppConfig } from "../config.js";
import { t, templateTitle } from "../i18n.js";
import { type BotLocale, DEFAULT_BOT_LOCALE, parseBotLocale } from "../locale.js";
import { log } from "../logger.js";
import {
  type JsonObject,
  type MeetingRecord,
  MeetingRequest,
  type MeetingTemplate,
  PendingAction,
  UserFacingError,
} from "../models.js";
import { parseInlineQuery } from "../parser.js";
import {
  claimInlineMessage,
  cleanupPendingActions,
  finalizeInlineMessage,
  getDueFollowups,
  getDueReminders,
  getInlineMessage,
  getMeeting,
  getUserLocale,
  listMeetingHistory,
  listUpcomingMeetings,
  markFollowupSent,
  markMeetingCancelled,
  markMeetingCompleted,
  markReminderSent,
  type OpenDatabase,
  popPendingAction,
  releaseInlineMessage,
  saveMeeting,
  savePendingAction,
  saveUserLocale,
  updateMeetingAfterReschedule,
} from "../storage/database.js";
import { formatDateTime } from "../time.js";
import { ZoomClient } from "../zoom.js";
import type { AppContext, BotRuntime } from "./context.js";

export function createBot(config: AppConfig, database: OpenDatabase): BotRuntime {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required to create a bot");
  const zoom = new ZoomClient(config);
  const bot = new Bot<AppContext>(config.TELEGRAM_BOT_TOKEN, { client: { apiRoot: config.TELEGRAM_API_ROOT } });
  const runtime = { bot, config, database, zoom } satisfies BotRuntime;

  bot.use(async (context, next) => {
    context.config = config;
    context.database = database;
    context.runtime = runtime;
    context.locale = getUserLocale(database, context.from?.id ?? ownerId(config));
    await next();
  });

  bot.inlineQuery(/.*/, async (context) => {
    if (!isOwner(context)) return;
    const query = context.inlineQuery.query.trim();
    log("info", "Inline query received", { query });
    const results = buildQuickRequests(config, context.locale).map((request) =>
      buildInlineResult(runtime, request, context.locale),
    );
    if (query) {
      try {
        results.unshift(buildInlineResult(runtime, parseInlineQuery(query, config, context.locale), context.locale));
      } catch (error) {
        results.push(buildErrorResult(context.locale, error));
      }
    }
    await context.answerInlineQuery(results, { cache_time: 0, is_personal: true });
  });

  bot.on("callback_query:data", async (context) => {
    const data = context.callbackQuery.data;
    if (data.startsWith("create:")) {
      await handleCreateCallback(context, data.slice("create:".length));
      return;
    }
    if (data.startsWith("preview_cancel:")) {
      await handlePreviewCancelCallback(context, data.slice("preview_cancel:".length));
      return;
    }
    if (data.startsWith("locale:")) {
      await handleLocaleCallback(context, data.slice("locale:".length));
      return;
    }
    if (data.startsWith("m:")) {
      if (!isOwner(context)) {
        await context.answerCallbackQuery({ text: t(context.locale, "callback.only-owner"), show_alert: true });
        return;
      }
      const [, rawRecordId, action] = data.split(":");
      const recordId = Number(rawRecordId);
      if (!Number.isSafeInteger(recordId) || !action) {
        await context.answerCallbackQuery({ text: t(context.locale, "callback.unknown-action"), show_alert: true });
        return;
      }
      await handleMeetingAction(context, recordId, action);
      return;
    }
    await context.answerCallbackQuery();
  });

  bot.command(["start", "help"], async (context) => {
    if (isOwner(context)) await context.reply(t(context.locale, "help.body"), { parse_mode: "HTML" });
  });
  bot.command("templates", async (context) => {
    if (!isOwner(context)) return;
    const lines = [t(context.locale, "templates.heading"), ""];
    for (const template of Object.values(config.templates)) {
      lines.push(
        t(context.locale, "templates.default-topic", {
          emoji: template.emoji,
          title: templateTitle(context.locale, template.key as "quick" | "lesson" | "call"),
          topic: template.defaultTopic[context.locale],
          minutes: template.durationMinutes,
        }),
      );
    }
    lines.push(
      "",
      t(context.locale, "templates.examples"),
      t(context.locale, "templates.example-call"),
      t(context.locale, "templates.example-lesson"),
      t(context.locale, "templates.example-weekly"),
    );
    await context.reply(lines.join("\n"), { parse_mode: "HTML" });
  });
  bot.command("list", async (context) => {
    if (isOwner(context))
      await sendMeetingList(
        context,
        listUpcomingMeetings(database, config.LIST_LIMIT),
        "list.upcoming-empty",
        "list.upcoming-prefix",
      );
  });
  bot.command("history", async (context) => {
    if (isOwner(context))
      await sendMeetingList(
        context,
        listMeetingHistory(database, config.LIST_LIMIT),
        "list.history-empty",
        "list.history-prefix",
      );
  });
  bot.command(["settings", "language"], async (context) => {
    if (isOwner(context))
      await context.reply(settingsText(context.locale), { reply_markup: settingsKeyboard(context.locale) });
  });
  bot.command("health", async (context) => {
    if (!isOwner(context)) return;
    const upcoming = listUpcomingMeetings(database, config.LIST_LIMIT);
    await context.reply(
      t(context.locale, "health.body", {
        database: htmlEscape(config.DATABASE_URL),
        upcoming: upcoming.length,
        reminder: config.REMINDER_LEAD_MINUTES,
        followup: config.FOLLOWUP_DELAY_MINUTES,
      }),
      { parse_mode: "HTML" },
    );
  });

  bot.catch((error) =>
    log("error", "Unhandled Telegram bot error", { error: error.error, update: error.ctx.update.update_id }),
  );
  return runtime;

  async function handleCreateCallback(context: AppContext, token: string): Promise<void> {
    const callbackQuery = context.callbackQuery;
    if (!callbackQuery) return;
    const inlineMessageId = callbackQuery.inline_message_id;
    if (inlineMessageId) {
      const existing = getInlineMessage(database, inlineMessageId);
      if (existing?.status === "done") {
        await context.answerCallbackQuery({ text: t(context.locale, "callback.already-created"), show_alert: true });
        await editCallbackMessage(context, existing.final_message);
        return;
      }
      const claim = claimInlineMessage(database, inlineMessageId);
      if (!claim.claimed) {
        await context.answerCallbackQuery({ text: t(context.locale, "callback.already-creating"), show_alert: true });
        if (claim.message) await editCallbackMessage(context, claim.message);
        return;
      }
    }

    const pending = popPendingAction(database, token);
    if (!pending) {
      await context.answerCallbackQuery({ text: t(context.locale, "callback.stale"), show_alert: true });
      if (inlineMessageId) releaseInlineMessage(database, inlineMessageId);
      return;
    }
    await context.answerCallbackQuery({ text: t(context.locale, "callback.creating") });
    try {
      const record = await createMeetingFromRequest(runtime, pending.request);
      const message = renderMeetingMessage(config, record, context.locale);
      if (inlineMessageId) finalizeInlineMessage(database, inlineMessageId, message, record.recordId);
      await editCallbackMessage(context, message);
    } catch (error) {
      if (inlineMessageId) releaseInlineMessage(database, inlineMessageId);
      log("error", "Meeting creation failed", { error });
      await editCallbackMessage(context, `❌ ${userFacingMessage(context.locale, error, "callback.create-error")}`);
    }
  }

  async function handlePreviewCancelCallback(context: AppContext, token: string): Promise<void> {
    const callbackQuery = context.callbackQuery;
    if (!callbackQuery) return;
    popPendingAction(database, token);
    await context.answerCallbackQuery({ text: t(context.locale, "callback.cancelled") });
    try {
      if (callbackQuery.message && !callbackQuery.inline_message_id) await context.deleteMessage();
      else await editCallbackMessage(context, t(context.locale, "callback.cancelled"));
    } catch (error) {
      log("warn", "Preview cancel edit failed", { error });
    }
  }

  async function handleLocaleCallback(context: AppContext, value: string): Promise<void> {
    if (!isOwner(context)) {
      await context.answerCallbackQuery({ text: t(context.locale, "callback.only-owner"), show_alert: true });
      return;
    }
    const locale = parseBotLocale(value);
    saveUserLocale(database, ownerId(config), locale);
    context.locale = locale;
    await context.answerCallbackQuery({
      text: t(locale, "settings.language-updated", {
        language: t(locale, `settings.language-${locale === "en" ? "english" : "russian"}`),
      }),
    });
    await editCallbackMessage(context, settingsText(locale), settingsKeyboard(locale));
  }

  async function handleMeetingAction(context: AppContext, recordId: number, action: string): Promise<void> {
    const current = getMeeting(database, recordId);
    if (!current) {
      await context.answerCallbackQuery({ text: t(context.locale, "callback.not-found"), show_alert: true });
      return;
    }
    await context.answerCallbackQuery({ text: t(context.locale, "callback.processing") });
    try {
      let record: MeetingRecord | null = current;
      let note = "";
      if (action === "cancel") {
        await zoom.cancelMeeting(current.zoomMeetingId);
        record = markMeetingCancelled(database, recordId);
        note = t(context.locale, "callback.zoom-cancelled");
      } else if (action === "plus1h") {
        const request = cloneRequest(current.sourceRequest);
        request.startDt = new Date(request.startDt.getTime() + 3_600_000);
        const response = await zoom.updateMeeting(current.zoomMeetingId, request);
        record = updateMeetingAfterReschedule(
          database,
          recordId,
          responseDate(response, request.startDt),
          request,
          stringValue(response.join_url),
        );
        note = t(context.locale, "callback.rescheduled-hour");
      } else if (action === "plus1d" || action === "duplicate") {
        const request = cloneRequest(current.sourceRequest);
        if (action === "plus1d") request.startDt = new Date(request.startDt.getTime() + 86_400_000);
        record = await createMeetingFromRequest(runtime, request);
        note = t(context.locale, action === "plus1d" ? "callback.rescheduled-day" : "callback.duplicated");
      } else {
        await editCallbackMessage(context, `❌ ${t(context.locale, "callback.unknown-meeting-action")}`);
        return;
      }
      if (!record) throw new Error(t(context.locale, "callback.updated-not-found"));
      await context.editMessageText(renderMeetingMessage(config, record, context.locale, note), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: false },
        reply_markup: meetingActionsKeyboard(record, context.locale),
      });
    } catch (error) {
      log("error", "Meeting action failed", { error, action, recordId });
      await editCallbackMessage(context, `❌ ${userFacingMessage(context.locale, error, "callback.action-error")}`);
    }
  }
}

export async function configureBot(bot: Bot<AppContext>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: t(DEFAULT_BOT_LOCALE, "commands.start") },
    { command: "templates", description: t(DEFAULT_BOT_LOCALE, "commands.templates") },
    { command: "list", description: t(DEFAULT_BOT_LOCALE, "commands.list") },
    { command: "history", description: t(DEFAULT_BOT_LOCALE, "commands.history") },
    { command: "settings", description: t(DEFAULT_BOT_LOCALE, "commands.settings") },
    { command: "health", description: t(DEFAULT_BOT_LOCALE, "commands.health") },
  ]);
}

export async function createMeetingFromRequest(runtime: BotRuntime, request: MeetingRequest): Promise<MeetingRecord> {
  log("info", "Meeting creation requested", {
    actionType: request.actionType,
    template: request.templateKey,
    startTime: request.startDt.toISOString(),
    duration: request.durationMinutes,
    invitees: request.inviteeEmails.length,
    recurrence: request.recurrence?.kind ?? null,
  });
  const response = await runtime.zoom.createMeeting(request);
  const settings = isObject(response.settings) ? response.settings : {};
  const record = saveMeeting(runtime.database, {
    zoomMeetingId: String(response.id),
    zoomMeetingUuid: stringValue(response.uuid) || null,
    topic: stringValue(response.topic) || request.topic,
    joinUrl: response.join_url,
    startDt: response.start_time ? new Date(response.start_time) : request.startDt,
    timezoneName: stringValue(response.timezone) || runtime.config.TZ,
    durationMinutes: numberValue(response.duration) ?? request.durationMinutes,
    templateKey: request.templateKey,
    inviteeEmails: request.inviteeEmails,
    status: "scheduled",
    sourceRequest: request,
    calendarPushRequested: settings.push_change_to_calendar === true,
    recordingStatus: runtime.config.ZOOM_AUTO_RECORDING ? "waiting_completion" : "disabled",
  });
  log("info", "Meeting creation succeeded", { recordId: record.recordId, zoomMeetingId: record.zoomMeetingId });
  return record;
}

export async function runReminderCycle(runtime: BotRuntime): Promise<void> {
  const { config, database, bot } = runtime;
  const locale = getUserLocale(database, ownerId(config));
  cleanupPendingActions(database, config.PENDING_ACTION_TTL_MINUTES, config.MAX_PENDING_ACTIONS);
  for (const record of getDueReminders(database, config.REMINDER_LEAD_MINUTES)) {
    try {
      await bot.api.sendMessage(
        ownerId(config),
        renderMeetingMessage(config, record, locale, t(locale, "reminder.text")),
        {
          parse_mode: "HTML",
          reply_markup: meetingActionsKeyboard(record, locale),
        },
      );
      markReminderSent(database, record.recordId);
      log("info", "Reminder sent", { recordId: record.recordId });
    } catch (error) {
      log("warn", "Reminder send failed", { recordId: record.recordId, error });
    }
  }
  for (const record of getDueFollowups(database, config.FOLLOWUP_DELAY_MINUTES)) {
    try {
      await bot.api.sendMessage(
        ownerId(config),
        renderMeetingMessage(config, record, locale, t(locale, "followup.text")),
        {
          parse_mode: "HTML",
          reply_markup: meetingActionsKeyboard(record, locale),
        },
      );
      markFollowupSent(database, record.recordId);
      markMeetingCompleted(database, record.recordId);
      log("info", "Follow-up sent", { recordId: record.recordId });
    } catch (error) {
      log("warn", "Follow-up send failed", { recordId: record.recordId, error });
    }
  }
}

function buildQuickRequests(config: AppConfig, locale: BotLocale): MeetingRequest[] {
  const startDt = new Date(Math.ceil((Date.now() + config.QUICK_MEETING_DELAY_MINUTES * 60_000) / 60_000) * 60_000);
  return ["quick", "lesson", "call"].map((key) => {
    const template = getTemplate(config, key);
    return new MeetingRequest(
      "quick",
      template.key,
      template.defaultTopic[locale],
      startDt,
      template.durationMinutes,
      [],
      null,
      templateTitle(locale, key as "quick" | "lesson" | "call"),
    );
  });
}

function buildInlineResult(runtime: BotRuntime, request: MeetingRequest, locale: BotLocale): InlineQueryResultArticle {
  cleanupPendingActions(
    runtime.database,
    runtime.config.PENDING_ACTION_TTL_MINUTES,
    runtime.config.MAX_PENDING_ACTIONS,
  );
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  savePendingAction(runtime.database, new PendingAction(token, request, new Date()));
  const template = getTemplate(runtime.config, request.templateKey);
  const inviteeText = request.inviteeEmails.length
    ? ` · ${t(locale, request.inviteeEmails.length === 1 ? "common.invitee" : "common.invitees", { count: request.inviteeEmails.length })}`
    : "";
  const recurringText = request.recurrence ? ` · ${t(locale, "common.recurring")}` : "";
  const description = `${renderRequestTimeDescription(runtime.config, request, locale)} · ${t(locale, "common.minute", { count: request.durationMinutes })}${inviteeText}${recurringText}`;
  const content: InputTextMessageContent = {
    message_text: renderRequestSummary(runtime.config, request, locale),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  return {
    type: "article",
    id: `${request.actionType}-${token}`,
    title: `${template.emoji} ${request.topic}`,
    description,
    input_message_content: content,
    reply_markup: createKeyboard(token, locale),
  };
}

function buildErrorResult(locale: BotLocale, error: unknown): InlineQueryResultArticle {
  const message = userFacingMessage(locale, error, "common.error");
  return {
    type: "article",
    id: `error-${crypto.randomUUID()}`,
    title: t(locale, "inline.error-title"),
    description: message,
    input_message_content: {
      message_text: t(locale, "inline.error-body", { message: htmlEscape(message) }),
      parse_mode: "HTML",
    },
  };
}

function createKeyboard(token: string, locale: BotLocale): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(locale, "button.confirm"), `create:${token}`)
    .text(t(locale, "button.cancel"), `preview_cancel:${token}`);
}

function settingsText(locale: BotLocale): string {
  return `${t(locale, "settings.heading")}\n\n${t(locale, "settings.language")}: ${t(locale, "settings.language-picker")}`;
}

function settingsKeyboard(locale: BotLocale): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(locale, "settings.language-english"), "locale:en")
    .text(t(locale, "settings.language-russian"), "locale:ru");
}

function meetingActionsKeyboard(record: MeetingRecord, locale: BotLocale): InlineKeyboard {
  const keyboard = new InlineKeyboard().url(t(locale, "button.open"), record.joinUrl);
  if (record.status === "scheduled") {
    keyboard
      .row()
      .text(t(locale, "button.plus-hour"), `m:${record.recordId}:plus1h`)
      .text(t(locale, "button.plus-day"), `m:${record.recordId}:plus1d`);
    keyboard
      .row()
      .text(t(locale, "button.duplicate"), `m:${record.recordId}:duplicate`)
      .text(t(locale, "button.cancel-meeting"), `m:${record.recordId}:cancel`);
  } else keyboard.row().text(t(locale, "button.recreate"), `m:${record.recordId}:duplicate`);
  return keyboard;
}

function renderRequestTimeLines(config: AppConfig, request: MeetingRequest, locale: BotLocale): string[] {
  const alexTime = formatDateTime(request.startDt, config.TZ, locale);
  if (!request.clientTimeZone || !request.clientLocation)
    return [t(locale, "common.alex-time", { time: htmlEscape(alexTime) })];
  const clientTime = formatDateTime(request.startDt, request.clientTimeZone, locale);
  return [
    t(locale, "common.alex-time", { time: htmlEscape(alexTime) }),
    t(locale, "common.client-time", {
      location: htmlEscape(request.clientLocation),
      time: htmlEscape(clientTime),
    }),
  ];
}

function renderRequestTimeDescription(config: AppConfig, request: MeetingRequest, locale: BotLocale): string {
  return renderRequestTimeLines(config, request, locale).join("\n");
}

function renderRequestSummary(config: AppConfig, request: MeetingRequest, locale: BotLocale): string {
  const lines = [
    `<b>${htmlEscape(request.topic)}</b>`,
    `<i>${t(locale, "common.zoom-meeting")}</i>`,
    ...renderRequestTimeLines(config, request, locale),
    t(locale, "common.minute", { count: request.durationMinutes }),
  ];
  const recurrence = formatRecurrence(locale, request.recurrence);
  if (recurrence) lines.push(htmlEscape(recurrence));
  return lines.join("\n");
}

export function renderMeetingMessage(
  config: AppConfig,
  record: MeetingRecord,
  locale: BotLocale,
  note?: string,
): string {
  if (record.status !== "scheduled") return `${t(locale, "meeting.cancelled")}${note ? `\n\n${htmlEscape(note)}` : ""}`;
  const lines = [
    `<b>${htmlEscape(record.topic)}</b>`,
    `<i>${t(locale, "common.zoom-meeting")}</i>`,
    ...renderRequestTimeLines(config, record.sourceRequest, locale),
    t(locale, "common.minute", { count: record.durationMinutes }),
  ];
  const recurrence = formatRecurrence(locale, record.sourceRequest.recurrence);
  if (recurrence) lines.push(htmlEscape(recurrence));
  lines.push("", `<a href="${htmlEscape(record.joinUrl)}">${t(locale, "button.open")}</a>`);
  if (note) lines.push("", htmlEscape(note));
  return lines.join("\n");
}

export function renderOwnerMeetingMessage(
  config: AppConfig,
  record: MeetingRecord,
  locale: BotLocale,
  note?: string,
): string {
  const template = getTemplate(config, record.templateKey);
  const lines = [
    record.status === "scheduled" ? t(locale, "meeting.created") : t(locale, "meeting.cancelled-title"),
    "",
    `${template.emoji} ${htmlEscape(t(locale, template.titleKey))}`,
    t(locale, "meeting.topic", { topic: htmlEscape(record.topic) }),
    ...renderRequestTimeLines(config, record.sourceRequest, locale),
    t(locale, "meeting.duration", { duration: record.durationMinutes }),
  ];
  if (record.inviteeEmails.length)
    lines.push(t(locale, "meeting.invitees", { invitees: record.inviteeEmails.map(htmlEscape).join(", ") }));
  const recurrence = formatRecurrence(locale, record.sourceRequest.recurrence);
  if (recurrence) lines.push(t(locale, "meeting.recurrence", { recurrence: htmlEscape(recurrence) }));
  lines.push(t(locale, "meeting.zoom-id", { id: htmlEscape(record.zoomMeetingId) }));
  if (record.status === "scheduled")
    lines.push(
      t(locale, "meeting.connect", { url: `<a href="${htmlEscape(record.joinUrl)}">${t(locale, "button.open")}</a>` }),
      "",
      record.calendarPushRequested ? t(locale, "meeting.calendar-ok") : t(locale, "meeting.calendar-unknown"),
    );
  if (note) lines.push("", htmlEscape(note));
  return lines.join("\n");
}

async function sendMeetingList(
  context: AppContext,
  meetings: MeetingRecord[],
  emptyKey: "list.upcoming-empty" | "list.history-empty",
  prefixKey: "list.upcoming-prefix" | "list.history-prefix",
): Promise<void> {
  if (meetings.length === 0) {
    await context.reply(t(context.locale, emptyKey));
    return;
  }
  await context.reply(
    t(context.locale, "meeting.count", { prefix: t(context.locale, prefixKey), count: meetings.length }),
  );
  for (const record of meetings)
    await context.reply(renderOwnerMeetingMessage(context.config, record, context.locale), {
      parse_mode: "HTML",
      reply_markup: meetingActionsKeyboard(record, context.locale),
    });
}

async function editCallbackMessage(context: AppContext, text: string, replyMarkup?: InlineKeyboard): Promise<void> {
  await context.editMessageText(text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function isOwner(context: AppContext): boolean {
  return context.from?.id !== undefined && context.config.ALLOWED_USERS.includes(context.from.id);
}

function ownerId(config: AppConfig): number {
  const id = config.ALLOWED_USERS[0];
  if (id === undefined) throw new Error("ALLOWED_USERS is empty");
  return id;
}

function cloneRequest(request: MeetingRequest): MeetingRequest {
  return MeetingRequest.fromJSON(request.toJSON());
}

function responseDate(response: JsonObject, fallback: Date): Date {
  const value = stringValue(response.start_time);
  return value ? new Date(value) : fallback;
}

function getTemplate(config: AppConfig, key: string): MeetingTemplate {
  const template = config.templates[key] ?? config.templates.call;
  if (!template) throw new Error("No meeting template configured");
  return template;
}

function formatRecurrence(locale: BotLocale, recurrence: MeetingRequest["recurrence"]): string | null {
  if (!recurrence) return null;
  if (recurrence.kind === "weekly" && recurrence.timeText)
    return t(locale, "recurrence.weekly", { time: recurrence.timeText });
  if (recurrence.kind === "monthly" && recurrence.timeText && recurrence.dayOfMonth)
    return t(locale, "recurrence.monthly", { day: recurrence.dayOfMonth, time: recurrence.timeText });
  return recurrence.humanLabel;
}

function userFacingMessage(
  locale: BotLocale,
  error: unknown,
  fallbackKey: "common.error" | "callback.create-error" | "callback.action-error",
): string {
  return error instanceof UserFacingError
    ? t(locale, error.key, error.params)
    : error instanceof Error
      ? error.message
      : t(locale, fallbackKey);
}

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
