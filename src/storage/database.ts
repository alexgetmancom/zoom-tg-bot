import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type BotLocale, DEFAULT_BOT_LOCALE, parseBotLocale } from "../locale.js";
import type { MeetingRecord, MeetingRequest, PendingAction } from "../models.js";
import { MeetingRequest as MeetingRequestClass, PendingAction as PendingActionClass } from "../models.js";
import { utcNow } from "../time.js";

export type OpenDatabase = {
  sqlite: Database;
  path: string;
  close: () => void;
};

type UserSettingsRow = { locale: string };
type InlineRow = { status: string; final_message: string; meeting_record_id: number | null };
type IdRow = { id: number };
type ColumnRow = { name: string };

const meetingExtraColumns: Record<string, string> = {
  zoom_meeting_uuid: "TEXT",
  recording_status: "TEXT",
  recording_completed_at: "TEXT",
  transcript_sent_at: "TEXT",
  summary_sent_at: "TEXT",
  transcript_failed_at: "TEXT",
  summary_failed_at: "TEXT",
  git_note_path: "TEXT",
  git_commit_sha: "TEXT",
  git_exported_at: "TEXT",
  git_export_failed_at: "TEXT",
};

export function openDatabase(url: string): OpenDatabase {
  const path = url === ":memory:" ? url : resolve(url);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA busy_timeout = 30000");
  if (path !== ":memory:") sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  return { sqlite, path, close: () => sqlite.close() };
}

export function migrateDatabase(database: OpenDatabase): void {
  database.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      token TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inline_messages (
      inline_message_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      final_message TEXT NOT NULL DEFAULT '',
      meeting_record_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zoom_meeting_id TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      join_url TEXT NOT NULL,
      start_time TEXT NOT NULL,
      timezone_name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      template_key TEXT NOT NULL,
      invitee_emails_json TEXT NOT NULL,
      status TEXT NOT NULL,
      source_request_json TEXT NOT NULL,
      calendar_push_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reminder_sent_at TEXT,
      followup_sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_hash TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      meeting_uuid TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS summary_emails (
      message_key TEXT PRIMARY KEY,
      meeting_record_id INTEGER NOT NULL,
      sent_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      locale TEXT NOT NULL DEFAULT 'en',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_start_time ON meetings(start_time);
    CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at);
  `);

  const columns = database.sqlite
    .query<ColumnRow, []>("PRAGMA table_info(meetings)")
    .all()
    .map((column) => column.name);
  for (const [name, type] of Object.entries(meetingExtraColumns)) {
    if (!columns.includes(name)) database.sqlite.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${type}`);
  }
}

export function getUserLocale(database: OpenDatabase, userId: number): BotLocale {
  const row = database.sqlite
    .query<UserSettingsRow, [number]>("SELECT locale FROM user_settings WHERE user_id = ?")
    .get(userId);
  return parseBotLocale(row?.locale, DEFAULT_BOT_LOCALE);
}

export function saveUserLocale(database: OpenDatabase, userId: number, locale: BotLocale): void {
  database.sqlite
    .query(
      "INSERT INTO user_settings (user_id, locale, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET locale = excluded.locale, updated_at = excluded.updated_at",
    )
    .run(userId, locale, utcNow().toISOString());
}

export function cleanupPendingActions(database: OpenDatabase, ttlMinutes: number, maxPendingActions: number): void {
  const cutoff = new Date(Date.now() - ttlMinutes * 60_000).toISOString();
  database.sqlite.query("DELETE FROM pending_actions WHERE created_at < ?").run(cutoff);
  database.sqlite.query("DELETE FROM inline_messages WHERE updated_at < ?").run(cutoff);
  const rows = database.sqlite
    .query<{ token: string }, []>("SELECT token FROM pending_actions ORDER BY created_at DESC")
    .all();
  for (const row of rows.slice(maxPendingActions))
    database.sqlite.query("DELETE FROM pending_actions WHERE token = ?").run(row.token);
}

export function savePendingAction(database: OpenDatabase, pending: PendingAction): void {
  database.sqlite
    .query("INSERT OR REPLACE INTO pending_actions (token, payload_json, created_at) VALUES (?, ?, ?)")
    .run(pending.token, JSON.stringify(pending.toJSON()), pending.createdAt.toISOString());
}

export function popPendingAction(database: OpenDatabase, token: string): PendingAction | null {
  const row = database.sqlite
    .query<{ payload_json: string }, [string]>("SELECT payload_json FROM pending_actions WHERE token = ?")
    .get(token);
  if (!row) return null;
  database.sqlite.query("DELETE FROM pending_actions WHERE token = ?").run(token);
  return PendingActionClass.fromJSON(JSON.parse(row.payload_json) as Parameters<typeof PendingActionClass.fromJSON>[0]);
}

export function getInlineMessage(database: OpenDatabase, inlineMessageId: string): InlineRow | null {
  const row = database.sqlite
    .query<InlineRow, [string]>(
      "SELECT status, final_message, meeting_record_id FROM inline_messages WHERE inline_message_id = ?",
    )
    .get(inlineMessageId);
  return row ?? null;
}

export function claimInlineMessage(
  database: OpenDatabase,
  inlineMessageId: string,
): { claimed: boolean; message: string | null } {
  const now = utcNow().toISOString();
  const result = database.sqlite
    .query(
      "INSERT OR IGNORE INTO inline_messages (inline_message_id, status, final_message, created_at, updated_at) VALUES (?, 'creating', '', ?, ?)",
    )
    .run(inlineMessageId, now, now);
  if (result.changes === 1) return { claimed: true, message: null };
  const row = database.sqlite
    .query<{ final_message: string }, [string]>("SELECT final_message FROM inline_messages WHERE inline_message_id = ?")
    .get(inlineMessageId);
  return { claimed: false, message: row?.final_message || null };
}

export function finalizeInlineMessage(
  database: OpenDatabase,
  inlineMessageId: string,
  finalMessage: string,
  recordId: number | null,
): void {
  database.sqlite
    .query(
      "UPDATE inline_messages SET status = 'done', final_message = ?, meeting_record_id = ?, updated_at = ? WHERE inline_message_id = ?",
    )
    .run(finalMessage, recordId, utcNow().toISOString(), inlineMessageId);
}

export function releaseInlineMessage(database: OpenDatabase, inlineMessageId: string): void {
  database.sqlite.query("DELETE FROM inline_messages WHERE inline_message_id = ?").run(inlineMessageId);
}

export function saveMeeting(
  database: OpenDatabase,
  values: {
    zoomMeetingId: string;
    zoomMeetingUuid: string | null;
    topic: string;
    joinUrl: string;
    startDt: Date;
    timezoneName: string;
    durationMinutes: number;
    templateKey: string;
    inviteeEmails: string[];
    status: string;
    sourceRequest: MeetingRequest;
    calendarPushRequested: boolean;
    recordingStatus: string | null;
  },
): MeetingRecord {
  const now = utcNow().toISOString();
  const result = database.sqlite
    .query(
      `INSERT INTO meetings (
        zoom_meeting_id, zoom_meeting_uuid, topic, join_url, start_time, timezone_name,
        duration_minutes, template_key, invitee_emails_json, status, source_request_json,
        calendar_push_requested, created_at, updated_at, recording_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.zoomMeetingId,
      values.zoomMeetingUuid,
      values.topic,
      values.joinUrl,
      values.startDt.toISOString(),
      values.timezoneName,
      values.durationMinutes,
      values.templateKey,
      JSON.stringify(values.inviteeEmails),
      values.status,
      JSON.stringify(values.sourceRequest.toJSON()),
      values.calendarPushRequested ? 1 : 0,
      now,
      now,
      values.recordingStatus,
    );
  const id = Number(result.lastInsertRowid);
  const record = getMeeting(database, id);
  if (!record) throw new Error(`Meeting was inserted but cannot be read: ${id}`);
  return record;
}

export function getMeeting(database: OpenDatabase, recordId: number): MeetingRecord | null {
  const row = database.sqlite.query<RawMeetingRow, [number]>("SELECT * FROM meetings WHERE id = ?").get(recordId);
  return row ? rowToMeeting(row) : null;
}

export function getMeetingByZoomId(database: OpenDatabase, zoomMeetingId: string): MeetingRecord | null {
  const row = database.sqlite
    .query<RawMeetingRow, [string]>("SELECT * FROM meetings WHERE zoom_meeting_id = ?")
    .get(zoomMeetingId);
  return row ? rowToMeeting(row) : null;
}

export function getMeetingByZoomUuid(database: OpenDatabase, zoomMeetingUuid: string): MeetingRecord | null {
  const row = database.sqlite
    .query<RawMeetingRow, [string]>("SELECT * FROM meetings WHERE zoom_meeting_uuid = ?")
    .get(zoomMeetingUuid);
  return row ? rowToMeeting(row) : null;
}

export function updateMeetingAfterReschedule(
  database: OpenDatabase,
  recordId: number,
  startDt: Date,
  request: MeetingRequest,
  joinUrl?: string,
): MeetingRecord | null {
  const values = [startDt.toISOString(), JSON.stringify(request.toJSON()), utcNow().toISOString(), recordId] as const;
  if (joinUrl) {
    database.sqlite
      .query("UPDATE meetings SET start_time = ?, source_request_json = ?, updated_at = ?, join_url = ? WHERE id = ?")
      .run(values[0], values[1], values[2], joinUrl, values[3]);
  } else {
    database.sqlite
      .query("UPDATE meetings SET start_time = ?, source_request_json = ?, updated_at = ? WHERE id = ?")
      .run(...values);
  }
  return getMeeting(database, recordId);
}

export function markMeetingCancelled(database: OpenDatabase, recordId: number): MeetingRecord | null {
  database.sqlite
    .query("UPDATE meetings SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(utcNow().toISOString(), recordId);
  return getMeeting(database, recordId);
}

export function markRecordingCompleted(
  database: OpenDatabase,
  values: { zoomMeetingId: string; zoomMeetingUuid: string | null; completedAt: Date },
): MeetingRecord | null {
  const row = database.sqlite
    .query<IdRow, [string, string | null, string | null]>(
      "SELECT id FROM meetings WHERE zoom_meeting_id = ? OR (? IS NOT NULL AND zoom_meeting_uuid = ?) ORDER BY id DESC LIMIT 1",
    )
    .get(values.zoomMeetingId, values.zoomMeetingUuid, values.zoomMeetingUuid);
  if (!row) return null;
  database.sqlite
    .query(
      "UPDATE meetings SET zoom_meeting_uuid = COALESCE(?, zoom_meeting_uuid), recording_status = 'completed', recording_completed_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(values.zoomMeetingUuid, values.completedAt.toISOString(), utcNow().toISOString(), row.id);
  return getMeeting(database, row.id);
}

export function markTranscriptSent(database: OpenDatabase, recordId: number): void {
  const now = utcNow().toISOString();
  database.sqlite
    .query(
      "UPDATE meetings SET transcript_sent_at = ?, recording_status = 'transcript_sent', updated_at = ? WHERE id = ?",
    )
    .run(now, now, recordId);
}

export function markSummarySent(database: OpenDatabase, recordId: number): void {
  const now = utcNow().toISOString();
  database.sqlite.query("UPDATE meetings SET summary_sent_at = ?, updated_at = ? WHERE id = ?").run(now, now, recordId);
}

export function markTranscriptFailed(database: OpenDatabase, recordId: number): void {
  const now = utcNow().toISOString();
  database.sqlite
    .query("UPDATE meetings SET transcript_failed_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, recordId);
}

export function markSummaryFailed(database: OpenDatabase, recordId: number): void {
  const now = utcNow().toISOString();
  database.sqlite
    .query("UPDATE meetings SET summary_failed_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, recordId);
}

export function markGitExported(
  database: OpenDatabase,
  recordId: number,
  notePath: string,
  commitSha: string | null,
): void {
  const now = utcNow().toISOString();
  database.sqlite
    .query(
      "UPDATE meetings SET git_note_path = ?, git_commit_sha = ?, git_exported_at = ?, git_export_failed_at = NULL, updated_at = ? WHERE id = ?",
    )
    .run(notePath, commitSha, now, now, recordId);
}

export function markGitExportFailed(database: OpenDatabase, recordId: number): void {
  const now = utcNow().toISOString();
  database.sqlite
    .query("UPDATE meetings SET git_export_failed_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, recordId);
}

export function claimWebhookEvent(
  database: OpenDatabase,
  eventHash: string,
  eventType: string,
  meetingUuid: string | null,
): boolean {
  const result = database.sqlite
    .query(
      "INSERT OR IGNORE INTO webhook_events (event_hash, event_type, meeting_uuid, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(eventHash, eventType, meetingUuid, utcNow().toISOString());
  return result.changes === 1;
}

export function markSummaryEmailProcessed(database: OpenDatabase, messageKey: string, meetingRecordId: number): void {
  database.sqlite
    .query("INSERT OR REPLACE INTO summary_emails (message_key, meeting_record_id, sent_at) VALUES (?, ?, ?)")
    .run(messageKey, meetingRecordId, utcNow().toISOString());
}

export function isSummaryEmailProcessed(database: OpenDatabase, messageKey: string): boolean {
  return Boolean(database.sqlite.query("SELECT 1 FROM summary_emails WHERE message_key = ?").get(messageKey));
}

export function listUpcomingMeetings(database: OpenDatabase, limit: number): MeetingRecord[] {
  const rows = database.sqlite
    .query<RawMeetingRow, [string, number]>(
      "SELECT * FROM meetings WHERE status = 'scheduled' AND start_time >= ? ORDER BY start_time ASC LIMIT ?",
    )
    .all(utcNow().toISOString(), limit);
  return rows.map(rowToMeeting);
}

export function listMeetingHistory(database: OpenDatabase, limit: number): MeetingRecord[] {
  return database.sqlite
    .query<RawMeetingRow, [number]>("SELECT * FROM meetings ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map(rowToMeeting);
}

export function getDueReminders(database: OpenDatabase, leadMinutes: number): MeetingRecord[] {
  const now = utcNow();
  const rows = database.sqlite
    .query<RawMeetingRow, [string, string]>(
      "SELECT * FROM meetings WHERE status = 'scheduled' AND reminder_sent_at IS NULL AND start_time >= ? AND start_time <= ? ORDER BY start_time ASC",
    )
    .all(now.toISOString(), new Date(now.getTime() + leadMinutes * 60_000).toISOString());
  return rows.map(rowToMeeting);
}

export function getDueFollowups(database: OpenDatabase, delayMinutes: number): MeetingRecord[] {
  const now = utcNow();
  const rows = database.sqlite
    .query<RawMeetingRow, []>(
      "SELECT * FROM meetings WHERE status = 'scheduled' AND followup_sent_at IS NULL ORDER BY start_time ASC",
    )
    .all();
  return rows
    .map(rowToMeeting)
    .filter((record) => record.startDt.getTime() + (record.durationMinutes + delayMinutes) * 60_000 <= now.getTime());
}

export function getMeetingsPendingTranscript(database: OpenDatabase): MeetingRecord[] {
  return database.sqlite
    .query<RawMeetingRow, []>(
      "SELECT * FROM meetings WHERE status = 'scheduled' AND recording_completed_at IS NOT NULL AND transcript_sent_at IS NULL AND transcript_failed_at IS NULL ORDER BY recording_completed_at ASC",
    )
    .all()
    .map(rowToMeeting);
}

export function getMeetingsPendingSummary(database: OpenDatabase): MeetingRecord[] {
  return database.sqlite
    .query<RawMeetingRow, []>(
      "SELECT * FROM meetings WHERE status = 'scheduled' AND summary_sent_at IS NULL AND summary_failed_at IS NULL ORDER BY start_time ASC",
    )
    .all()
    .map(rowToMeeting);
}

export function getMeetingsPendingGitExport(database: OpenDatabase): MeetingRecord[] {
  return database.sqlite
    .query<RawMeetingRow, []>(
      "SELECT * FROM meetings WHERE status = 'scheduled' AND git_exported_at IS NULL AND git_export_failed_at IS NULL ORDER BY start_time ASC",
    )
    .all()
    .map(rowToMeeting);
}

export function markReminderSent(database: OpenDatabase, recordId: number): void {
  const now = utcNow().toISOString();
  database.sqlite
    .query("UPDATE meetings SET reminder_sent_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, recordId);
}

export function markFollowupSent(database: OpenDatabase, recordId: number): void {
  const now = utcNow().toISOString();
  database.sqlite
    .query("UPDATE meetings SET followup_sent_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, recordId);
}

type RawMeetingRow = {
  id: number;
  zoom_meeting_id: string;
  zoom_meeting_uuid: string | null;
  topic: string;
  join_url: string;
  start_time: string;
  timezone_name: string;
  duration_minutes: number;
  template_key: string;
  invitee_emails_json: string;
  status: string;
  source_request_json: string;
  created_at: string;
  updated_at: string;
  calendar_push_requested: number;
  recording_status: string | null;
  recording_completed_at: string | null;
  transcript_sent_at: string | null;
  summary_sent_at: string | null;
  transcript_failed_at: string | null;
  summary_failed_at: string | null;
  git_note_path: string | null;
  git_commit_sha: string | null;
  git_exported_at: string | null;
  git_export_failed_at: string | null;
  reminder_sent_at: string | null;
  followup_sent_at: string | null;
};

function rowToMeeting(row: RawMeetingRow): MeetingRecord {
  return {
    recordId: row.id,
    zoomMeetingId: row.zoom_meeting_id,
    zoomMeetingUuid: row.zoom_meeting_uuid,
    topic: row.topic,
    joinUrl: row.join_url,
    startDt: new Date(row.start_time),
    timezoneName: row.timezone_name,
    durationMinutes: row.duration_minutes,
    templateKey: row.template_key,
    inviteeEmails: JSON.parse(row.invitee_emails_json) as string[],
    status: row.status,
    sourceRequest: MeetingRequestClass.fromJSON(
      JSON.parse(row.source_request_json) as Parameters<typeof MeetingRequestClass.fromJSON>[0],
    ),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    calendarPushRequested: Boolean(row.calendar_push_requested),
    recordingStatus: row.recording_status,
    recordingCompletedAt: row.recording_completed_at ? new Date(row.recording_completed_at) : null,
    transcriptSentAt: row.transcript_sent_at ? new Date(row.transcript_sent_at) : null,
    summarySentAt: row.summary_sent_at ? new Date(row.summary_sent_at) : null,
    transcriptFailedAt: row.transcript_failed_at ? new Date(row.transcript_failed_at) : null,
    summaryFailedAt: row.summary_failed_at ? new Date(row.summary_failed_at) : null,
    gitNotePath: row.git_note_path,
    gitCommitSha: row.git_commit_sha,
    gitExportedAt: row.git_exported_at ? new Date(row.git_exported_at) : null,
    gitExportFailedAt: row.git_export_failed_at ? new Date(row.git_export_failed_at) : null,
    reminderSentAt: row.reminder_sent_at ? new Date(row.reminder_sent_at) : null,
    followupSentAt: row.followup_sent_at ? new Date(row.followup_sent_at) : null,
  };
}
