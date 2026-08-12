import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { MeetingRequest, PendingAction } from "../src/models.js";
import {
  getMeeting,
  getUserLocale,
  markMeetingCompleted,
  markSummarySent,
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
    const request = new MeetingRequest(
      "scheduled",
      "call",
      "Demo",
      new Date("2099-12-31T12:00:00Z"),
      60,
      [],
      null,
      "",
      "America/New_York",
      "Майами",
    );
    savePendingAction(database, new PendingAction("token", request, new Date("2099-01-01T00:00:00Z")));
    expect(popPendingAction(database, "token")?.request.topic).toBe("Demo");
    expect(popPendingAction(database, "token")).toBeNull();
    database.close();
  });

  test("stores a meeting record in the compatible SQLite schema", () => {
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const request = new MeetingRequest(
      "scheduled",
      "call",
      "Demo",
      new Date("2099-12-31T12:00:00Z"),
      60,
      [],
      null,
      "",
      "America/New_York",
      "Майами",
    );
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
    markSummarySent(database, record.recordId, "# Demo summary");
    markMeetingCompleted(database, record.recordId);
    const stored = getMeeting(database, record.recordId);
    expect(stored?.summaryText).toBe("# Demo summary");
    expect(stored?.completedAt).toBeInstanceOf(Date);
    expect(stored?.sourceRequest.clientTimeZone).toBe("America/New_York");
    expect(stored?.sourceRequest.clientLocation).toBe("Майами");
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
