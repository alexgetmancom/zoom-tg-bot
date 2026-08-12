import { describe, expect, test } from "bun:test";
import { renderMeetingMessage } from "../src/bot/bot.js";
import { loadConfig } from "../src/config.js";
import { parseInlineQuery } from "../src/parser.js";
import { migrateDatabase, openDatabase, saveMeeting } from "../src/storage/database.js";

const config = loadConfig({ BOT_MODE: "http-only", TZ: "Europe/Moscow" });

describe("meeting time display", () => {
  test("shows Alex and Miami local times in the Russian meeting message", () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const request = parseInlineQuery("31.12.2099 12:00 Савелий - Майами", config, "ru");
    const record = saveMeeting(database, {
      zoomMeetingId: "123",
      zoomMeetingUuid: null,
      topic: request.topic,
      joinUrl: "https://zoom.test/join",
      startDt: request.startDt,
      timezoneName: config.TZ,
      durationMinutes: request.durationMinutes,
      templateKey: request.templateKey,
      inviteeEmails: request.inviteeEmails,
      status: "scheduled",
      sourceRequest: request,
      calendarPushRequested: false,
      recordingStatus: "disabled",
    });

    const message = renderMeetingMessage(config, record, "ru");
    expect(message).toContain("Местное время Алексея: 31.12 в 12:00");
    expect(message).toContain("Местное время клиента (Майами): 31.12 в 04:00");
    expect(message).not.toContain("Савелий - Майами");
    database.close();
  });
});
