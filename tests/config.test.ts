import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  test("uses boilerplate runtime defaults", () => {
    const config = loadConfig({ BOT_MODE: "http-only" });
    expect(config.APP_NAME).toBe("zoom-tg-bot");
    expect(config.PORT).toBe(8080);
    expect(config.TZ).toBe("Europe/Moscow");
  });

  test("parses a closed Telegram allowlist", () => {
    expect(loadConfig({ BOT_MODE: "http-only", ALLOWED_USERS: "42, 7" }).ALLOWED_USERS).toEqual([42, 7]);
    expect(() => loadConfig({ BOT_MODE: "http-only", ALLOWED_USERS: "42,nope" })).toThrow(ConfigurationError);
  });

  test("parses false boolean values as false", () => {
    expect(loadConfig({ BOT_MODE: "http-only", MEETING_WAITING_ROOM: "false" }).MEETING_WAITING_ROOM).toBe(false);
    expect(loadConfig({ BOT_MODE: "http-only", MEETING_WAITING_ROOM: "yes" }).MEETING_WAITING_ROOM).toBe(true);
  });

  test("requires bot credentials only when the bot is enabled", () => {
    expect(() => loadConfig({ BOT_MODE: "webhook" })).toThrow(ConfigurationError);
    expect(loadConfig({ BOT_MODE: "http-only" }).BOT_MODE).toBe("http-only");
  });
});
