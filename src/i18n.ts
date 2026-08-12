import { catalog, type MessageKey } from "./i18n/catalog.js";
import type { BotLocale } from "./locale.js";

export type { MessageKey };

export function t(locale: BotLocale, key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalog[locale][key] ?? catalog.en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

export function templateTitle(locale: BotLocale, key: "quick" | "lesson" | "call"): string {
  return t(locale, `template.${key}.title`);
}

export function templateTopic(locale: BotLocale, key: "quick" | "lesson" | "call"): string {
  return t(locale, `template.${key}.topic`);
}
