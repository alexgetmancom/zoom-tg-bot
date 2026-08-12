import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { t } from "../src/i18n.js";
import { parseInlineQuery } from "../src/parser.js";
import { formatDateTime } from "../src/time.js";

describe("bot language", () => {
  test("uses English as the default interface language", () => {
    expect(t("en", "settings.language")).toBe("🌐 Language");
    expect(loadConfig({ BOT_MODE: "http-only" }).templates.call?.defaultTopic.en).toBe("Call");
  });

  test("keeps Russian as a selectable product locale", () => {
    expect(t("ru", "settings.language")).toBe("🌐 Язык");
    const config = loadConfig({ BOT_MODE: "http-only", TZ: "Europe/Moscow" });
    expect(parseInlineQuery("14:30", config, "ru").topic).toBe("Созвон");
    expect(formatDateTime(new Date("2026-08-13T09:00:00Z"), "Europe/Moscow", "ru")).toBe("13.08 в 12:00");
    expect(formatDateTime(new Date("2026-08-13T09:00:00Z"), "America/New_York", "ru")).toBe("13.08 в 05:00");
    expect(formatDateTime(new Date("2026-12-13T09:00:00Z"), "America/New_York", "ru")).toBe("13.12 в 04:00");
    expect(t("ru", "common.alex-time", { time: "13.08 в 12:00" })).toBe("Время Москва: 13.08 в 12:00");
    expect(t("ru", "common.client-time", { location: "Майами", time: "13.08 в 05:00" })).toBe(
      "Время Майами: 13.08 в 05:00",
    );
  });
});
