import { type BotLocale, DEFAULT_BOT_LOCALE } from "./locale.js";

export type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsFor(date: Date, timeZone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

export function localDateTimeParts(date: Date, timeZone: string): LocalDateTimeParts {
  return partsFor(date, timeZone);
}

export function zonedDateTimeToDate(parts: LocalDateTimeParts, timeZone: string): Date {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const guessed = new Date(utcGuess);
  const rendered = partsFor(guessed, timeZone);
  const renderedAsUtc = Date.UTC(
    rendered.year,
    rendered.month - 1,
    rendered.day,
    rendered.hour,
    rendered.minute,
    rendered.second,
  );
  return new Date(utcGuess - (renderedAsUtc - utcGuess));
}

export function formatDateTime(
  date: Date,
  timeZone: string,
  locale: BotLocale = DEFAULT_BOT_LOCALE,
  withYear = false,
): string {
  const parts = partsFor(date, timeZone);
  const datePart = withYear
    ? `${String(parts.day).padStart(2, "0")}.${String(parts.month).padStart(2, "0")}.${parts.year}`
    : `${String(parts.day).padStart(2, "0")}.${String(parts.month).padStart(2, "0")}`;
  const connector = locale === "ru" ? "в" : "at";
  return `${datePart} ${connector} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function formatDateTimePlain(date: Date, timeZone: string): string {
  const parts = partsFor(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
}

export function formatDateTimeWithYear(date: Date, timeZone: string): string {
  const parts = partsFor(date, timeZone);
  return `${String(parts.day).padStart(2, "0")}.${String(parts.month).padStart(2, "0")}.${parts.year} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function utcNow(): Date {
  return new Date();
}

export function parseIsoDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

export function formatZoomUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
