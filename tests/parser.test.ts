import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { extractClientTimeZone, extractDuration, normalizeMonthDates, parseInlineQuery } from "../src/parser.js";

const config = loadConfig({ BOT_MODE: "http-only", TZ: "Europe/Moscow" });

describe("inline query parser", () => {
  test("extracts template, duration and invitees", () => {
    const request = parseInlineQuery("урок завтра 11:00 90m student@example.com", config);
    expect(request.templateKey).toBe("lesson");
    expect(request.durationMinutes).toBe(90);
    expect(request.inviteeEmails).toEqual(["student@example.com"]);
    expect(request.actionType).toBe("scheduled");
  });

  test("keeps a topic after removing schedule tokens", () => {
    const request = parseInlineQuery("созвон 31.12.2099 16:30 команда", config);
    expect(request.topic).toBe("команда");
  });

  test("parses a date with a word month before the time", () => {
    const now = new Date("2026-08-12T08:00:00Z");
    expect(normalizeMonthDates("13 августа 12:00 Тест", now, "Europe/Moscow")).toBe("13.08.2026 12:00 Тест");
    const request = parseInlineQuery("13 августа 12:00 Тест", config);
    expect(request.actionType).toBe("scheduled");
    expect(request.topic).toBe("Тест");
  });

  test("splits a supported client city from the topic and keeps Alex's time as the input", () => {
    const request = parseInlineQuery("31.12.2099 12:00 Савелий - Майами", config);
    expect(request.topic).toBe("Савелий");
    expect(request.clientLocation).toBe("Майами");
    expect(request.clientTimeZone).toBe("America/New_York");
    expect(request.startDt.toISOString()).toBe("2099-12-31T09:00:00.000Z");
  });

  test("leaves an unknown suffix in the topic", () => {
    expect(extractClientTimeZone("31.12.2099 12:00 Савелий - Неизвестный город").text).toBe(
      "31.12.2099 12:00 Савелий - Неизвестный город",
    );
  });

  test("parses recurring weekly meetings", () => {
    const request = parseInlineQuery("каждый пн 16:30 команда", config);
    expect(request.actionType).toBe("recurring");
    expect(request.recurrence?.kind).toBe("weekly");
    expect(request.topic).toBe("команда");
  });

  test("rejects malformed emails and non-positive duration", () => {
    expect(() => parseInlineQuery("14:30 broken@example", config)).toThrow();
    expect(() => parseInlineQuery("14:30 0m", config)).toThrow();
  });

  test("supports hour duration notation", () => {
    expect(extractDuration("2ч", 60).durationMinutes).toBe(120);
  });
});
