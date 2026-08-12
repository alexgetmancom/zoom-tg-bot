import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { t } from "../src/i18n.js";
import { parseInlineQuery } from "../src/parser.js";

describe("bot language", () => {
  test("uses English as the default interface language", () => {
    expect(t("en", "settings.language")).toBe("🌐 Language");
    expect(loadConfig({ BOT_MODE: "http-only" }).templates.call?.defaultTopic.en).toBe("Call");
  });

  test("keeps Russian as a selectable product locale", () => {
    expect(t("ru", "settings.language")).toBe("🌐 Язык");
    const config = loadConfig({ BOT_MODE: "http-only", TZ: "Europe/Moscow" });
    expect(parseInlineQuery("14:30", config, "ru").topic).toBe("Созвон");
  });
});
