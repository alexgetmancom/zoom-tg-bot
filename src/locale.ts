export const BOT_LOCALES = ["en", "ru"] as const;
export type BotLocale = (typeof BOT_LOCALES)[number];

export const DEFAULT_BOT_LOCALE: BotLocale = "en";

export function parseBotLocale(value: unknown, fallback: BotLocale = DEFAULT_BOT_LOCALE): BotLocale {
  return typeof value === "string" && (BOT_LOCALES as readonly string[]).includes(value)
    ? (value as BotLocale)
    : fallback;
}
