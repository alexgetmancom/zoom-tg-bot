import type { AppConfig } from "./config.js";
import { type BotLocale, DEFAULT_BOT_LOCALE } from "./locale.js";
import { MeetingRequest, type MeetingTemplate, type Recurrence, UserFacingError } from "./models.js";
import {
  DURATION_HOUR_UNITS,
  DURATION_RE,
  MONTH_MAP,
  MONTHLY_RECURRENCE_RE,
  RELATIVE_DATE_WORDS,
  SCHEDULE_TOKEN_RE,
  WEEKDAY_MAP,
  WEEKLY_RECURRENCE_RE,
  WORD_DATE_RE,
} from "./parser-lexicon.js";
import { localDateTimeParts, zonedDateTimeToDate } from "./time.js";

const EMAIL_RE = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
const LEFTOVER_EMAIL_RE = /\S+@\S+/;
const TIME_RE = /\b\d{1,2}:\d{2}\b/;
const DATE_TOKEN_RE = /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/;

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeRelativeDates(text: string, now: Date, timeZone: string): string {
  let normalized = text;
  for (const [word, dayDelta] of Object.entries(RELATIVE_DATE_WORDS)) {
    const date = new Date(now.getTime() + dayDelta * 86_400_000);
    const parts = localDateTimeParts(date, timeZone);
    const dateString = `${String(parts.day).padStart(2, "0")}.${String(parts.month).padStart(2, "0")}.${parts.year}`;
    normalized = normalized.replace(wordRegex(word), dateString);
  }
  return normalized;
}

export function normalizeMonthDates(text: string, now: Date, timeZone: string): string {
  const nowParts = localDateTimeParts(now, timeZone);
  return text.replace(WORD_DATE_RE, (full, rawDay: string, rawMonth: string, rawYear?: string) => {
    const month = MONTH_MAP[rawMonth.toLowerCase().replace(/\.$/, "")];
    if (!month) return full;
    const day = Number(rawDay);
    const numericYear = rawYear ? Number(rawYear) : nowParts.year;
    const year = numericYear < 100 ? numericYear + 2000 : numericYear;
    return `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
  });
}

export function extractEmails(text: string): { text: string; emails: string[] } {
  const emails = [...text.matchAll(EMAIL_RE)]
    .map((match) => match[1])
    .filter((email): email is string => Boolean(email));
  return { text: normalizeSpaces(text.replace(EMAIL_RE, " ")), emails: [...new Set(emails)].sort() };
}

export function extractDuration(text: string, defaultMinutes: number): { text: string; durationMinutes: number } {
  const match = text.match(DURATION_RE);
  if (!match) return { text, durationMinutes: defaultMinutes };
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "m";
  const durationMinutes = DURATION_HOUR_UNITS.includes(unit) ? value * 60 : value;
  return {
    text: normalizeSpaces(`${text.slice(0, match.index)} ${text.slice((match.index ?? 0) + match[0].length)}`),
    durationMinutes,
  };
}

export function selectTemplate(text: string, config: AppConfig): { text: string; template: MeetingTemplate } {
  const tokens = text.split(" ");
  const aliases = new Map<string, MeetingTemplate>();
  for (const template of Object.values(config.templates)) {
    for (const alias of template.aliases) aliases.set(alias, template);
  }
  const first = tokens[0]?.toLowerCase().replace(/:$/, "");
  const firstTemplate = first ? aliases.get(first) : undefined;
  if (firstTemplate) return { text: normalizeSpaces(tokens.slice(1).join(" ")), template: firstTemplate };
  for (let index = 0; index < tokens.length; index += 1) {
    const template = aliases.get(tokens[index]?.toLowerCase().replace(/:$/, "") ?? "");
    if (template)
      return { text: normalizeSpaces(tokens.filter((_, tokenIndex) => tokenIndex !== index).join(" ")), template };
  }
  const template = config.templates[config.DEFAULT_SCHEDULED_TEMPLATE] ?? config.templates.call;
  if (!template) throw new Error("No scheduled meeting template configured");
  return { text, template };
}

function parseTime(value: string): { hour: number; minute: number } {
  const [rawHour = Number.NaN, rawMinute = Number.NaN] = value.split(":").map(Number);
  if (
    !Number.isInteger(rawHour) ||
    !Number.isInteger(rawMinute) ||
    rawHour < 0 ||
    rawHour > 23 ||
    rawMinute < 0 ||
    rawMinute > 59
  ) {
    throw new UserFacingError("error.invalid-time");
  }
  return { hour: rawHour, minute: rawMinute };
}

function nextWeekdayStart(now: Date, weekday: number, hour: number, minute: number, timeZone: string): Date {
  const nowParts = localDateTimeParts(now, timeZone);
  const currentWeekday =
    ((new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day)).getUTCDay() + 6) % 7) + 1;
  let deltaDays = (weekday - currentWeekday + 7) % 7;
  const candidate = zonedDateTimeToDate({ ...nowParts, hour, minute, second: 0 }, timeZone);
  if (deltaDays === 0 && candidate <= now) deltaDays = 7;
  return new Date(candidate.getTime() + deltaDays * 86_400_000);
}

export function parseRecurrence(
  text: string,
  config: AppConfig,
): { text: string; recurrence: Recurrence | null; startDt: Date | null } {
  const now = new Date();
  const timeZone = config.TZ;
  const weekly = text.match(WEEKLY_RECURRENCE_RE);
  if (weekly) {
    const weekdays = (weekly[1] ?? "")
      .replace(/,/g, " ")
      .split(/\s+/)
      .map((token) => WEEKDAY_MAP[token.toLowerCase()])
      .filter((day): day is number => Boolean(day));
    const uniqueDays = [...new Set(weekdays)];
    if (uniqueDays.length === 0) throw new UserFacingError("error.weekday");
    const timeText = weekly[2] ?? "";
    const { hour, minute } = parseTime(timeText);
    const recurrence: Recurrence = {
      kind: "weekly",
      humanLabel: `Every week at ${timeText}`,
      timeText,
      zoom: {
        type: 2,
        repeat_interval: 1,
        weekly_days: uniqueDays.join(","),
        end_times: config.RECURRING_DEFAULT_WEEKLY_OCCURRENCES,
      },
    };
    const firstWeekday = uniqueDays[0];
    if (firstWeekday === undefined) throw new UserFacingError("error.weekday");
    return {
      text: normalizeSpaces(weekly[3] ?? ""),
      recurrence,
      startDt: nextWeekdayStart(now, firstWeekday, hour, minute, timeZone),
    };
  }

  const monthly = text.match(MONTHLY_RECURRENCE_RE);
  if (monthly) {
    const day = Number(monthly[1]);
    if (day < 1 || day > 28) throw new UserFacingError("error.monthly-day");
    const timeText = monthly[2] ?? "";
    const { hour, minute } = parseTime(timeText);
    const nowParts = localDateTimeParts(now, timeZone);
    let year = nowParts.year;
    let month = nowParts.month;
    let startDt = zonedDateTimeToDate({ year, month, day, hour, minute, second: 0 }, timeZone);
    if (startDt <= now) {
      month += 1;
      if (month === 13) {
        month = 1;
        year += 1;
      }
      startDt = zonedDateTimeToDate({ year, month, day, hour, minute, second: 0 }, timeZone);
    }
    return {
      text: normalizeSpaces(monthly[3] ?? ""),
      recurrence: {
        kind: "monthly",
        humanLabel: `Every ${day}th at ${timeText}`,
        timeText,
        dayOfMonth: day,
        zoom: {
          type: 3,
          repeat_interval: 1,
          monthly_day: day,
          end_times: config.RECURRING_DEFAULT_MONTHLY_OCCURRENCES,
        },
      },
      startDt,
    };
  }
  return { text, recurrence: null, startDt: null };
}

export function queryHasExplicitDate(query: string): boolean {
  return (
    DATE_TOKEN_RE.test(query) ||
    new RegExp(WORD_DATE_RE.source, "i").test(query) ||
    new RegExp(`(?<![\\p{L}\\p{N}_])(?:${Object.keys(RELATIVE_DATE_WORDS).join("|")})(?![\\p{L}\\p{N}_])`, "iu").test(
      query,
    )
  );
}

export function stripScheduleTokens(text: string): string {
  let result = text.replace(DATE_TOKEN_RE, " ");
  result = result.replace(WORD_DATE_RE, (full, _day: string, month: string) =>
    MONTH_MAP[month.toLowerCase().replace(/\.$/, "")] ? " " : full,
  );
  result = result.replace(TIME_RE, " ");
  for (const word of Object.keys(RELATIVE_DATE_WORDS)) result = result.replace(wordRegex(word), " ");
  result = result.replace(SCHEDULE_TOKEN_RE, " ");
  return normalizeSpaces(result);
}

function wordRegex(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, "giu");
}

function explicitDateParts(text: string, now: Date, timeZone: string): { year: number; month: number; day: number } {
  const dateMatch = text.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/);
  const nowParts = localDateTimeParts(now, timeZone);
  if (!dateMatch) return { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  const rawYear = dateMatch[3] ? Number(dateMatch[3]) : nowParts.year;
  return { year: rawYear < 100 ? rawYear + 2000 : rawYear, month: Number(dateMatch[2]), day: Number(dateMatch[1]) };
}

export function parseInlineQuery(
  query: string,
  config: AppConfig,
  locale: BotLocale = DEFAULT_BOT_LOCALE,
): MeetingRequest {
  const rawQuery = normalizeSpaces(query);
  if (!rawQuery) throw new UserFacingError("error.empty-query");

  const selected = selectTemplate(rawQuery, config);
  const recurrent = parseRecurrence(selected.text, config);
  const emailResult = extractEmails(recurrent.text);
  if (LEFTOVER_EMAIL_RE.test(emailResult.text)) throw new UserFacingError("error.invalid-email");
  const durationResult = extractDuration(emailResult.text, selected.template.durationMinutes);
  if (durationResult.durationMinutes <= 0) throw new UserFacingError("error.invalid-duration");

  if (recurrent.recurrence && recurrent.startDt) {
    const topic = stripScheduleTokens(durationResult.text) || selected.template.defaultTopic[locale];
    return new MeetingRequest(
      "recurring",
      selected.template.key,
      topic,
      recurrent.startDt,
      durationResult.durationMinutes,
      emailResult.emails,
      recurrent.recurrence,
      rawQuery,
    );
  }

  if (!TIME_RE.test(durationResult.text)) {
    throw new UserFacingError("error.missing-date-time");
  }

  const now = new Date();
  const normalized = normalizeMonthDates(normalizeRelativeDates(durationResult.text, now, config.TZ), now, config.TZ);
  const timeMatch = normalized.match(TIME_RE);
  if (!timeMatch) throw new UserFacingError("error.missing-time");
  const { hour, minute } = parseTime(timeMatch[0]);
  const dateParts = explicitDateParts(normalized, now, config.TZ);
  let startDt = zonedDateTimeToDate({ ...dateParts, hour, minute, second: 0 }, config.TZ);
  if (!queryHasExplicitDate(normalized) && startDt <= now) startDt = new Date(startDt.getTime() + 86_400_000);
  if (startDt.getTime() <= now.getTime() - 60_000) throw new UserFacingError("error.past-date");
  const topic = stripScheduleTokens(durationResult.text) || selected.template.defaultTopic[locale];
  return new MeetingRequest(
    "scheduled",
    selected.template.key,
    topic,
    startDt,
    durationResult.durationMinutes,
    emailResult.emails,
    null,
    rawQuery,
  );
}
