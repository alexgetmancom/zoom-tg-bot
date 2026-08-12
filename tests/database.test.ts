import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { MeetingRequest, PendingAction } from "../src/models.js";
import {
  getMeeting,
  getUserLocale,
  migrateDatabase,
  openDatabase,
  popPendingAction,
  saveMeeting,
  savePendingAction,
  saveUserLocale,
} from "../src/storage/database.js";

const config = loadConfig({ BOT_MODE: "http-only" });

describe("SQLite state", () => {
  test("migrates, stores and reads pending actions", () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const request = new MeetingRequest("scheduled", "call", "Demo", new Date("2099-12-31T12:00:00Z"), 60, []);
    savePendingAction(database, new PendingAction("token", request, new Date("2099-01-01T00:00:00Z")));
    expect(popPendingAction(database, "token")?.request.topic).toBe("Demo");
    expect(popPendingAction(database, "token")).toBeNull();
    database.close();
  });

  test("stores a meeting record in the compatible SQLite schema", () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const request = new MeetingRequest("scheduled", "call", "Demo", new Date("2099-12-31T12:00:00Z"), 60, []);
    const record = saveMeeting(database, {
      zoomMeetingId: "123",
      zoomMeetingUuid: null,
      topic: "Demo",
      joinUrl: "https://zoom.test/join",
      startDt: request.startDt,
      timezoneName: config.TZ,
      durationMinutes: 60,
      templateKey: "call",
      inviteeEmails: [],
      status: "scheduled",
      sourceRequest: request,
      calendarPushRequested: true,
      recordingStatus: "disabled",
    });
    expect(getMeeting(database, record.recordId)?.zoomMeetingId).toBe("123");
    database.close();
  });

  test("defaults the owner language to English and persists a Russian choice", () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    expect(getUserLocale(database, 42)).toBe("en");
    saveUserLocale(database, 42, "ru");
    expect(getUserLocale(database, 42)).toBe("ru");
    database.close();
  });
});
