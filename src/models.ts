import type { MessageKey } from "./i18n.js";
import type { BotLocale } from "./locale.js";

export type JsonObject = Record<string, unknown>;

export class UserFacingError extends Error {
  constructor(
    public readonly key: MessageKey,
    public readonly params: Record<string, string | number> = {},
  ) {
    super(key);
    this.name = "UserFacingError";
  }
}

export type MeetingTemplate = {
  key: string;
  titleKey: MessageKey;
  emoji: string;
  aliases: string[];
  defaultTopic: Record<BotLocale, string>;
  durationMinutes: number;
};

export type Recurrence = {
  kind: "weekly" | "monthly";
  humanLabel: string;
  timeText?: string;
  dayOfMonth?: number;
  zoom: JsonObject;
};

export type RecurrenceData = {
  kind: "weekly" | "monthly";
  human_label: string;
  time_text?: string;
  day_of_month?: number;
  zoom: JsonObject;
};

export type MeetingRequestData = {
  action_type: string;
  template_key: string;
  topic: string;
  start_dt: string;
  duration_minutes: number;
  invitee_emails: string[];
  recurrence: RecurrenceData | null;
  source_query: string;
};

export class MeetingRequest {
  constructor(
    public actionType: string,
    public templateKey: string,
    public topic: string,
    public startDt: Date,
    public durationMinutes: number,
    public inviteeEmails: string[],
    public recurrence: Recurrence | null = null,
    public sourceQuery = "",
  ) {}

  get recurrenceLabel(): string | null {
    return this.recurrence?.humanLabel ?? null;
  }

  toJSON(): MeetingRequestData {
    return {
      action_type: this.actionType,
      template_key: this.templateKey,
      topic: this.topic,
      start_dt: this.startDt.toISOString(),
      duration_minutes: this.durationMinutes,
      invitee_emails: this.inviteeEmails,
      recurrence: this.recurrence
        ? {
            kind: this.recurrence.kind,
            human_label: this.recurrence.humanLabel,
            zoom: this.recurrence.zoom,
            ...(this.recurrence.timeText ? { time_text: this.recurrence.timeText } : {}),
            ...(this.recurrence.dayOfMonth ? { day_of_month: this.recurrence.dayOfMonth } : {}),
          }
        : null,
      source_query: this.sourceQuery,
    };
  }

  static fromJSON(payload: MeetingRequestData): MeetingRequest {
    const rawRecurrence = payload.recurrence as (RecurrenceData & { humanLabel?: string }) | null;
    const recurrence = rawRecurrence
      ? {
          kind: rawRecurrence.kind,
          humanLabel: rawRecurrence.humanLabel ?? rawRecurrence.human_label ?? "",
          ...(rawRecurrence.time_text ? { timeText: rawRecurrence.time_text } : {}),
          ...(rawRecurrence.day_of_month ? { dayOfMonth: rawRecurrence.day_of_month } : {}),
          zoom: rawRecurrence.zoom,
        }
      : null;
    return new MeetingRequest(
      payload.action_type,
      payload.template_key,
      payload.topic,
      new Date(payload.start_dt),
      Number(payload.duration_minutes),
      [...payload.invitee_emails],
      recurrence,
      payload.source_query,
    );
  }
}

export type PendingActionData = {
  token: string;
  request: MeetingRequestData;
  created_at: string;
};

export class PendingAction {
  constructor(
    public token: string,
    public request: MeetingRequest,
    public createdAt: Date,
  ) {}

  toJSON(): PendingActionData {
    return {
      token: this.token,
      request: this.request.toJSON(),
      created_at: this.createdAt.toISOString(),
    };
  }

  static fromJSON(payload: PendingActionData): PendingAction {
    return new PendingAction(payload.token, MeetingRequest.fromJSON(payload.request), new Date(payload.created_at));
  }
}

export type MeetingRecord = {
  recordId: number;
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
  createdAt: Date;
  updatedAt: Date;
  calendarPushRequested: boolean;
  recordingStatus: string | null;
  recordingCompletedAt: Date | null;
  transcriptSentAt: Date | null;
  summarySentAt: Date | null;
  transcriptFailedAt: Date | null;
  summaryFailedAt: Date | null;
  summaryText: string | null;
  completedAt: Date | null;
  reminderSentAt: Date | null;
  followupSentAt: Date | null;
};

export type ZoomMeetingResponse = JsonObject & {
  id: string | number;
  join_url: string;
  uuid?: string;
  topic?: string;
  start_time?: string;
  timezone?: string;
  duration?: number;
  settings?: JsonObject;
};
