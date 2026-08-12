import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import { buildRawSummaryMarkdown, GitNotesExporter, summaryPayloadHasContent } from "./git-notes.js";
import { t } from "./i18n.js";
import { log } from "./logger.js";
import type { JsonObject, MeetingRecord } from "./models.js";
import { SUMMARY_EMAIL_MARKERS } from "./parser-lexicon.js";
import {
  claimWebhookEvent,
  getMeetingsPendingGitExport,
  getMeetingsPendingSummary,
  getMeetingsPendingTranscript,
  getUserLocale,
  isSummaryEmailProcessed,
  markGitExported,
  markGitExportFailed,
  markRecordingCompleted,
  markSummaryEmailProcessed,
  markSummaryFailed,
  markSummarySent,
  markTranscriptFailed,
  markTranscriptSent,
  type OpenDatabase,
} from "./storage/database.js";
import { formatDateTimeWithYear, utcNow } from "./time.js";
import type { ZoomClient } from "./zoom.js";

export class TelegramDeliveryClient {
  private readonly baseUrl: string;

  constructor(private readonly config: AppConfig) {
    this.baseUrl = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN ?? ""}`;
  }

  async sendText(text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: ownerId(this.config), text, disable_web_page_preview: true });
  }

  async sendDocument(filename: string, content: Uint8Array, caption: string, mimeType: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(ownerId(this.config)));
    form.append("caption", caption);
    form.append("document", new File([content], filename, { type: mimeType }));
    const response = await fetch(`${this.baseUrl}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Telegram sendDocument failed with HTTP ${response.status}`);
  }

  private async call(method: string, body: JsonObject): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
  }
}

export class ArtifactWorker {
  static readonly summaryReadyGraceMinutes = 2;
  private readonly telegram: TelegramDeliveryClient;
  private readonly gitNotes: GitNotesExporter;
  private readonly summaryEmails: SummaryEmailFetcher;

  constructor(
    private readonly config: AppConfig,
    private readonly database: OpenDatabase,
    private readonly zoom: ZoomClient,
  ) {
    this.telegram = new TelegramDeliveryClient(config);
    this.gitNotes = new GitNotesExporter(config);
    this.summaryEmails = new SummaryEmailFetcher(config, database);
  }

  get imapEnabled(): boolean {
    return this.summaryEmails.enabled;
  }

  get gitNotesEnabled(): boolean {
    return this.gitNotes.enabled;
  }

  async handleWebhook(rawBody: Uint8Array, headers: Headers): Promise<Response> {
    let payload: JsonObject;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
      if (!isObject(parsed)) throw new Error("payload is not an object");
      payload = parsed;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const event = stringValue(payload.event);
    if (event === "endpoint.url_validation") {
      const nested = isObject(payload.payload) ? payload.payload : {};
      const plainToken = stringValue(nested.plainToken) || stringValue(payload.plainToken);
      if (!plainToken) return jsonResponse({ error: "missing_plain_token" }, 400);
      const encryptedToken = createHmac("sha256", this.config.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(plainToken)
        .digest("hex");
      log("info", "Zoom webhook URL validated");
      return jsonResponse({ plainToken, encryptedToken });
    }

    if (!this.verifySignature(rawBody, headers)) {
      log("warn", "Zoom webhook signature rejected", { event });
      return jsonResponse({ error: "invalid_signature" }, 401);
    }
    const eventHash = createHash("sha256").update(rawBody).digest("hex");
    const webhookPayload = isObject(payload.payload) ? payload.payload : {};
    const meetingObject = isObject(webhookPayload.object) ? webhookPayload.object : {};
    const meetingUuid = stringValue(meetingObject.uuid) || null;
    if (!claimWebhookEvent(this.database, eventHash, event, meetingUuid)) return jsonResponse({ status: "duplicate" });

    if (["recording.completed", "recording.transcript_completed"].includes(event)) {
      const eventTimestamp = numberValue(payload.event_ts);
      const completedAt = eventTimestamp
        ? new Date(eventTimestamp > 10_000_000_000 ? eventTimestamp : eventTimestamp * 1000)
        : utcNow();
      const record = markRecordingCompleted(this.database, {
        zoomMeetingId: stringValue(meetingObject.id),
        zoomMeetingUuid: meetingUuid,
        completedAt,
      });
      log(record ? "info" : "debug", record ? "Recording completed received" : "Recording completion ignored", {
        recordId: record?.recordId,
        zoomMeetingId: meetingObject.id,
        event,
      });
    }
    if (["meeting.summary_completed", "meeting.summary_updated"].includes(event))
      log("info", "Meeting summary event received", { meetingUuid, zoomMeetingId: meetingObject.id, event });
    return jsonResponse({ status: "ok" });
  }

  async processCycle(): Promise<void> {
    await this.processPendingTranscripts();
    await this.processPendingSummaries();
    await this.processPendingGitExports();
  }

  private verifySignature(rawBody: Uint8Array, headers: Headers): boolean {
    const timestamp = headers.get("x-zm-request-timestamp") ?? "";
    const signature = headers.get("x-zm-signature") ?? "";
    if (!timestamp || !signature || !this.config.ZOOM_WEBHOOK_SECRET_TOKEN) return false;
    const timestampNumber = Number(timestamp);
    if (!Number.isInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300)
      return false;
    const message = `v0:${timestamp}:${new TextDecoder().decode(rawBody)}`;
    const expected = `v0=${createHmac("sha256", this.config.ZOOM_WEBHOOK_SECRET_TOKEN).update(message).digest("hex")}`;
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(signature);
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  }

  private async processPendingTranscripts(): Promise<void> {
    const timeout = this.config.ARTIFACT_POLL_TIMEOUT_MINUTES * 60_000;
    for (const record of getMeetingsPendingTranscript(this.database)) {
      if (!record.recordingCompletedAt) continue;
      try {
        if (await this.sendTranscript(record)) continue;
      } catch (error) {
        log("warn", "Transcript processing retry", {
          recordId: record.recordId,
          reason: error instanceof Error ? error.name : String(error),
        });
        continue;
      }
      if (Date.now() - record.recordingCompletedAt.getTime() >= timeout) {
        const locale = getUserLocale(this.database, ownerId(this.config));
        await this.telegram.sendText(
          t(locale, "artifact.transcript-timeout", {
            topic: record.topic,
            when: formatDateTimeWithYear(record.startDt, this.config.TZ),
          }),
        );
        markTranscriptFailed(this.database, record.recordId);
      }
    }
  }

  private async processPendingSummaries(): Promise<void> {
    const timeout = this.config.ARTIFACT_POLL_TIMEOUT_MINUTES * 60_000;
    for (const record of getMeetingsPendingSummary(this.database)) {
      const reference = this.summaryReferenceDate(record);
      if (Date.now() < reference.getTime() + ArtifactWorker.summaryReadyGraceMinutes * 60_000) continue;
      try {
        if (await this.sendSummary(record)) continue;
      } catch (error) {
        log("warn", "Summary processing retry", {
          recordId: record.recordId,
          reason: error instanceof Error ? error.name : String(error),
        });
        continue;
      }
      if (Date.now() - reference.getTime() >= timeout) {
        const locale = getUserLocale(this.database, ownerId(this.config));
        await this.telegram.sendText(
          t(locale, "artifact.summary-timeout", {
            topic: record.topic,
            when: formatDateTimeWithYear(record.startDt, this.config.TZ),
          }),
        );
        markSummaryFailed(this.database, record.recordId);
      }
    }
  }

  private async processPendingGitExports(): Promise<void> {
    if (!this.gitNotes.enabled) return;
    const timeout = this.config.ARTIFACT_POLL_TIMEOUT_MINUTES * 60_000;
    for (const record of getMeetingsPendingGitExport(this.database)) {
      const reference = this.summaryReferenceDate(record);
      if (Date.now() < reference.getTime() + ArtifactWorker.summaryReadyGraceMinutes * 60_000) continue;
      try {
        const payload = await this.fetchSummaryPayload(record);
        if (payload && summaryPayloadHasContent(payload)) {
          const result = this.gitNotes.exportSummary(record, payload);
          markGitExported(this.database, record.recordId, result.notePath, result.commitSha);
          continue;
        }
      } catch (error) {
        log("warn", "Git note export retry", {
          recordId: record.recordId,
          reason: error instanceof Error ? error.name : String(error),
        });
        continue;
      }
      if (Date.now() - reference.getTime() >= timeout) markGitExportFailed(this.database, record.recordId);
    }
  }

  private async sendTranscript(record: MeetingRecord): Promise<boolean> {
    const recordings = await this.getRecordings(record);
    const file = findTranscriptFile(recordings);
    const downloadUrl = stringValue(file?.download_url);
    if (!downloadUrl) return false;
    const text = parseZoomTranscriptVtt(await this.zoom.downloadRecordingFile(downloadUrl));
    if (!text) return false;
    await this.telegram.sendDocument(
      buildTranscriptFilename(this.config, record),
      new TextEncoder().encode(
        `Meeting: ${record.topic}\nWhen: ${formatDateTimeWithYear(record.startDt, this.config.TZ)}\n\n${text.trim()}\n`,
      ),
      t(getUserLocale(this.database, ownerId(this.config)), "artifact.transcript-caption", { topic: record.topic }),
      "text/plain",
    );
    markTranscriptSent(this.database, record.recordId);
    log("info", "Transcript sent", { recordId: record.recordId });
    return true;
  }

  private async sendSummary(record: MeetingRecord): Promise<boolean> {
    const payload = await this.fetchSummaryPayload(record);
    if (payload && summaryPayloadHasContent(payload)) {
      await this.telegram.sendDocument(
        buildSummaryFilename(this.config, record),
        new TextEncoder().encode(renderSummaryDocumentFromApi(this.config, record, payload)),
        t(getUserLocale(this.database, ownerId(this.config)), "artifact.summary-caption", { topic: record.topic }),
        "text/markdown",
      );
      markSummarySent(this.database, record.recordId);
      log("info", "Summary sent", { recordId: record.recordId, source: "meeting_summary_api" });
      return true;
    }
    const candidate = await this.summaryEmails.findSummaryForMeeting(record);
    if (candidate?.text) {
      await this.telegram.sendDocument(
        buildSummaryFilename(this.config, record),
        new TextEncoder().encode(renderSummaryDocument(this.config, record, candidate.text)),
        t(getUserLocale(this.database, ownerId(this.config)), "artifact.summary-caption", { topic: record.topic }),
        "text/markdown",
      );
      markSummarySent(this.database, record.recordId);
      markSummaryEmailProcessed(this.database, candidate.messageKey, record.recordId);
      log("info", "Summary sent", { recordId: record.recordId, source: "summary_email_fallback" });
      return true;
    }
    return false;
  }

  private async getRecordings(record: MeetingRecord): Promise<JsonObject> {
    if (record.zoomMeetingUuid) {
      try {
        return await this.zoom.getMeetingRecordings(record.zoomMeetingUuid, true);
      } catch {
        // UUID encoding differs across Zoom API deployments; retry by numeric id below.
      }
    }
    return this.zoom.getMeetingRecordings(record.zoomMeetingId);
  }

  private summaryReferenceDate(record: MeetingRecord): Date {
    return record.recordingCompletedAt ?? new Date(record.startDt.getTime() + record.durationMinutes * 60_000);
  }

  private async fetchSummaryPayload(record: MeetingRecord): Promise<JsonObject | null> {
    if (record.zoomMeetingUuid) {
      try {
        return await this.zoom.getMeetingSummary(record.zoomMeetingUuid);
      } catch {
        // Fall through to the summary list lookup.
      }
    }
    const reference = this.summaryReferenceDate(record);
    const items = await this.iterSummaryItems(
      new Date(reference.getTime() - 86_400_000),
      new Date(reference.getTime() + 86_400_000),
    );
    const topic = normalizeMatchText(record.topic);
    let best: { item: JsonObject; score: [number, number] } | null = null;
    for (const item of items) {
      const itemTopic = normalizeMatchText(stringValue(item.meeting_topic));
      const itemUuid = stringValue(item.meeting_uuid);
      const itemId = stringValue(item.meeting_id);
      const primary =
        record.zoomMeetingUuid && itemUuid === record.zoomMeetingUuid
          ? 4
          : itemId === record.zoomMeetingId
            ? 3
            : itemTopic === topic
              ? 2
              : topic && itemTopic.includes(topic)
                ? 1
                : 0;
      if (!primary) continue;
      const itemStart = new Date(stringValue(item.meeting_start_time));
      const distance = Number.isNaN(itemStart.getTime())
        ? 0
        : -Math.abs(itemStart.getTime() - record.startDt.getTime());
      const isBetter = !best || primary > best.score[0] || (primary === best.score[0] && distance > best.score[1]);
      if (isBetter) best = { item, score: [primary, distance] };
    }
    const uuid = best ? stringValue(best.item.meeting_uuid) : "";
    return uuid ? this.zoom.getMeetingSummary(uuid) : null;
  }

  private async iterSummaryItems(from: Date, to: Date): Promise<JsonObject[]> {
    const items: JsonObject[] = [];
    let token: string | undefined;
    do {
      const payload = await this.zoom.listMeetingSummaries(from, to, 100, token);
      const summaries = Array.isArray(payload.summaries) ? payload.summaries : [];
      items.push(...summaries.filter(isObject));
      token = stringValue(payload.next_page_token) || undefined;
    } while (token);
    return items;
  }
}

type SummaryEmailCandidate = { messageKey: string; text: string };

class SummaryEmailFetcher {
  constructor(
    private readonly config: AppConfig,
    private readonly database: OpenDatabase,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.ZOOM_IMAP_HOST && this.config.ZOOM_IMAP_USERNAME && this.config.ZOOM_IMAP_PASSWORD);
  }

  async findSummaryForMeeting(record: MeetingRecord): Promise<SummaryEmailCandidate | null> {
    if (!this.enabled) return null;
    const client = new ImapFlow({
      host: this.config.ZOOM_IMAP_HOST,
      port: this.config.ZOOM_IMAP_PORT,
      secure: true,
      auth: { user: this.config.ZOOM_IMAP_USERNAME, pass: this.config.ZOOM_IMAP_PASSWORD },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock(this.config.ZOOM_IMAP_FOLDER);
      try {
        const since = new Date((record.recordingCompletedAt ?? record.startDt).getTime() - 6 * 3_600_000);
        const criteria = this.config.ZOOM_SUMMARY_EMAIL_FROM
          ? { since, from: this.config.ZOOM_SUMMARY_EMAIL_FROM }
          : { since };
        const search = await client.search(criteria, { uid: true });
        if (search === false) return null;
        for await (const message of client.fetch(search, { envelope: true, source: true, uid: true }, { uid: true })) {
          const messageKey = message.envelope?.messageId ?? String(message.uid);
          if (isSummaryEmailProcessed(this.database, messageKey)) continue;
          const subject = message.envelope?.subject ?? "";
          const text = extractMailText(message.source ? new Uint8Array(message.source) : new Uint8Array());
          const haystack = normalizeMatchText(`${subject}\n${text}`);
          const topic = normalizeMatchText(record.topic);
          const tokens = topic.split(" ").filter((token) => token.length >= 3);
          const overlap = tokens.filter((token) => haystack.includes(token)).length;
          const relevantTopic = !topic || haystack.includes(topic) || overlap >= Math.min(2, tokens.length);
          const summaryMarker = SUMMARY_EMAIL_MARKERS.some((marker) => haystack.includes(marker));
          if (relevantTopic && summaryMarker && text.trim()) return { messageKey, text: text.trim() };
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    return null;
  }
}

export function parseZoomTranscriptVtt(bytes: Uint8Array): string {
  const lines: string[] = [];
  let previous = "";
  for (const raw of new TextDecoder().decode(bytes).split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line ||
      line.toUpperCase().startsWith("WEBVTT") ||
      line.includes("-->") ||
      /^\d+$/.test(line) ||
      line.startsWith("NOTE") ||
      line === previous
    )
      continue;
    lines.push(line);
    previous = line;
  }
  return lines.join("\n").trim();
}

export function sanitizeFilenameComponent(value: string): string {
  return (
    value
      .trim()
      .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
      .replace(/^[._]+|[._]+$/g, "")
      .slice(0, 80) || "meeting"
  );
}

export function buildTranscriptFilename(config: AppConfig, record: MeetingRecord): string {
  const parts = localDateParts(record.startDt, config.TZ);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}_${String(parts.hour).padStart(2, "0")}${String(parts.minute).padStart(2, "0")}_${sanitizeFilenameComponent(record.topic)}_transcript.txt`;
}

export function buildSummaryFilename(config: AppConfig, record: MeetingRecord): string {
  const parts = localDateParts(record.startDt, config.TZ);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}_${String(parts.hour).padStart(2, "0")}${String(parts.minute).padStart(2, "0")}_${sanitizeFilenameComponent(record.topic)}_zoom-summary.md`;
}

export function renderSummaryDocument(config: AppConfig, record: MeetingRecord, text: string): string {
  return `# Zoom AI Companion Summary\n\nMeeting: ${record.topic}\nWhen: ${formatDateTimeWithYear(record.startDt, config.TZ)}\n\nSource: Zoom AI Companion Summary\n\n${text.trim()}\n`;
}

export function renderSummaryDocumentFromApi(config: AppConfig, record: MeetingRecord, payload: JsonObject): string {
  const title = stringValue(payload.summary_title).trim() || "Zoom AI Companion Summary";
  const body = buildRawSummaryMarkdown(payload) || "_No summary body returned by Zoom._";
  return `# ${title}\n\nMeeting: ${record.topic}\nWhen: ${formatDateTimeWithYear(record.startDt, config.TZ)}\n\nSource: Zoom Meeting Summary API\n\n${body}\n`;
}

function findTranscriptFile(payload: JsonObject): JsonObject | null {
  const files = Array.isArray(payload.recording_files) ? payload.recording_files : [];
  return files.find(
    (file) =>
      isObject(file) &&
      (stringValue(file.file_type).toUpperCase() === "TRANSCRIPT" ||
        stringValue(file.file_extension).toUpperCase() === "VTT" ||
        stringValue(file.recording_type).toLowerCase().includes("transcript")),
  ) as JsonObject | null;
}

function extractMailText(source: Uint8Array): string {
  const raw = new TextDecoder().decode(source);
  const body = raw.split(/\r?\n\r?\n/, 2)[1] ?? raw;
  return body
    .replace(/--[-_A-Za-z0-9]+--?/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/=[0-9A-F]{2}/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMatchText(value: string): string {
  return value.replace(/\s+/g, " ").toLocaleLowerCase().trim();
}

function localDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function ownerId(config: AppConfig): number {
  const id = config.ALLOWED_USERS[0];
  if (id === undefined) throw new Error("ALLOWED_USERS is empty");
  return id;
}

function jsonResponse(payload: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
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
