import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import type { JsonObject, MeetingRequest, UserFacingError, ZoomMeetingResponse } from "./models.js";
import { UserFacingError as UserFacingErrorClass } from "./models.js";
import { formatDateTimePlain, formatZoomUtc } from "./time.js";

export class ZoomClient {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private apiBaseUrl = "https://api.zoom.us";

  constructor(private readonly config: AppConfig) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedToken && Date.now() < this.tokenExpiresAt) return this.cachedToken;
    const basic = btoa(`${this.config.ZOOM_CLIENT_ID}:${this.config.ZOOM_CLIENT_SECRET}`);
    const params = new URLSearchParams({ grant_type: "account_credentials", account_id: this.config.ZOOM_ACCOUNT_ID });
    let response: Response;
    try {
      response = await fetch(`https://zoom.us/oauth/token?${params}`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      log("warn", "Zoom token request failed", { error });
      throw new UserFacingErrorClass("error.zoom-token-network");
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const message = stringValue(payload.reason) || stringValue(payload.message) || response.statusText;
      throw new UserFacingErrorClass("error.zoom-token-response", { message });
    }
    const accessToken = stringValue(payload.access_token);
    if (!accessToken) throw new UserFacingErrorClass("error.zoom-token-empty");
    const expiresIn = numberValue(payload.expires_in) ?? 3600;
    this.cachedToken = accessToken;
    this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
    const apiUrl = stringValue(payload.api_url);
    if (apiUrl) this.apiBaseUrl = apiUrl.replace(/\/$/, "");
    log("info", "Zoom access token refreshed", { apiBaseUrl: this.apiBaseUrl });
    return accessToken;
  }

  async request(
    method: string,
    path: string,
    options: { json?: JsonObject; query?: Record<string, string | number>; retryUnauthorized?: boolean } = {},
  ): Promise<JsonObject> {
    const attempts = this.config.ZOOM_REQUEST_RETRY_ATTEMPTS;
    let retryUnauthorized = options.retryUnauthorized ?? true;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const token = await this.getAccessToken();
      const url = new URL(`${this.apiBaseUrl}/v2${path}`);
      for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: options.json ? JSON.stringify(options.json) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        if (attempt < attempts) {
          log("warn", "Zoom request retry", {
            method,
            path,
            attempt,
            reason: error instanceof Error ? error.name : String(error),
          });
          await Bun.sleep(this.config.ZOOM_RETRY_BACKOFF_SECONDS * attempt * 1000);
          continue;
        }
        log("warn", "Zoom request failed", { error, method, path });
        throw new UserFacingErrorClass("error.zoom-network");
      }

      if (response.status === 401 && retryUnauthorized) {
        await this.getAccessToken(true);
        retryUnauthorized = false;
        attempt -= 1;
        continue;
      }
      if ([500, 502, 503, 504].includes(response.status) && attempt < attempts) {
        log("warn", "Zoom request retry", { method, path, attempt, statusCode: response.status });
        await Bun.sleep(this.config.ZOOM_RETRY_BACKOFF_SECONDS * attempt * 1000);
        continue;
      }
      const payload = await readJson(response);
      if (response.ok) return payload;
      throw zoomError(response.status, payload);
    }
    throw new UserFacingErrorClass("error.zoom-retries");
  }

  buildSettings(request: MeetingRequest): JsonObject {
    const settings: JsonObject = {
      calendar_type: 2,
      push_change_to_calendar: true,
      auto_start_meeting_summary: true,
      waiting_room: this.config.MEETING_WAITING_ROOM,
      join_before_host: this.config.MEETING_JOIN_BEFORE_HOST,
      mute_upon_entry: this.config.MEETING_MUTE_UPON_ENTRY,
      host_video: this.config.MEETING_HOST_VIDEO,
      participant_video: this.config.MEETING_PARTICIPANT_VIDEO,
      default_password: this.config.MEETING_USE_DEFAULT_PASSCODE,
    };
    if (this.config.ZOOM_AUTO_RECORDING && !["none", "off", "false", "0"].includes(this.config.ZOOM_AUTO_RECORDING)) {
      settings.auto_recording = this.config.ZOOM_AUTO_RECORDING;
    }
    if (request.inviteeEmails.length > 0) settings.meeting_invitees = request.inviteeEmails.map((email) => ({ email }));
    return settings;
  }

  buildPayload(request: MeetingRequest): JsonObject {
    const payload: JsonObject = {
      topic: request.topic,
      start_time: formatDateTimePlain(request.startDt, this.config.TZ),
      timezone: this.config.TZ,
      duration: request.durationMinutes,
      settings: this.buildSettings(request),
      type: request.recurrence ? 8 : 2,
    };
    if (this.config.MEETING_PASSCODE) payload.password = this.config.MEETING_PASSCODE;
    if (request.recurrence) payload.recurrence = request.recurrence.zoom;
    return payload;
  }

  async createMeeting(request: MeetingRequest): Promise<ZoomMeetingResponse> {
    return (await this.request(
      "POST",
      `/users/${encodeURIComponent(this.config.ZOOM_HOST_USER_ID_OR_EMAIL)}/meetings`,
      { json: this.buildPayload(request) },
    )) as ZoomMeetingResponse;
  }

  async getMeeting(zoomMeetingId: string): Promise<JsonObject> {
    return this.request("GET", `/meetings/${encodeURIComponent(zoomMeetingId)}`);
  }

  async getMeetingRecordings(meetingIdentifier: string, useUuid = false): Promise<JsonObject> {
    let encoded = meetingIdentifier;
    if (useUuid) encoded = encodeURIComponent(encodeURIComponent(meetingIdentifier));
    return this.request("GET", `/meetings/${encoded}/recordings`);
  }

  async listMeetingSummaries(fromDt: Date, toDt: Date, pageSize = 30, nextPageToken?: string): Promise<JsonObject> {
    const query: Record<string, string | number> = {
      from: formatZoomUtc(fromDt),
      to: formatZoomUtc(toDt),
      page_size: pageSize,
    };
    if (nextPageToken) query.next_page_token = nextPageToken;
    return this.request("GET", "/meetings/meeting_summaries", { query });
  }

  async getMeetingSummary(meetingUuid: string): Promise<JsonObject> {
    const candidates = [
      meetingUuid,
      encodeURIComponent(meetingUuid),
      encodeURIComponent(encodeURIComponent(meetingUuid)),
    ];
    let lastError: UserFacingError | null = null;
    for (const candidate of candidates) {
      try {
        return await this.request("GET", `/meetings/${candidate}/meeting_summary`);
      } catch (error) {
        if (!(error instanceof UserFacingErrorClass)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new UserFacingErrorClass("error.zoom-summary-missing");
  }

  async updateMeeting(zoomMeetingId: string, request: MeetingRequest): Promise<JsonObject> {
    await this.request("PATCH", `/meetings/${encodeURIComponent(zoomMeetingId)}`, { json: this.buildPayload(request) });
    return this.getMeeting(zoomMeetingId);
  }

  async cancelMeeting(zoomMeetingId: string): Promise<void> {
    await this.request("DELETE", `/meetings/${encodeURIComponent(zoomMeetingId)}`);
  }

  async downloadRecordingFile(downloadUrl: string): Promise<Uint8Array> {
    let token = await this.getAccessToken();
    let response = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 401) {
      token = await this.getAccessToken(true);
      response = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
    }
    if (!response.ok) {
      const fallbackUrl = new URL(downloadUrl);
      fallbackUrl.searchParams.set("access_token", token);
      response = await fetch(fallbackUrl, { signal: AbortSignal.timeout(60_000) });
    }
    if (!response.ok) throw new UserFacingErrorClass("error.zoom-download", { status: response.status });
    return new Uint8Array(await response.arrayBuffer());
  }

  formatMeetingStart(date: Date): string {
    return formatDateTimePlain(date, this.config.TZ);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : value === undefined || value === null ? null : String(value);
}

function numberValue(value: unknown): number | null {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  if (!text) return {};
  try {
    const payload: unknown = JSON.parse(text);
    return payload !== null && typeof payload === "object" ? (payload as JsonObject) : {};
  } catch {
    return { message: text };
  }
}

function zoomError(status: number, payload: JsonObject): UserFacingError {
  const message = stringValue(payload.message) || JSON.stringify(payload) || `HTTP ${status}`;
  const lower = message.toLowerCase();
  if (status === 400 && lower.includes("no permission")) {
    return new UserFacingErrorClass("error.zoom-permission");
  }
  if (status === 401) return new UserFacingErrorClass("error.zoom-auth");
  if (status === 404) return new UserFacingErrorClass("error.zoom-not-found");
  if (status === 429) return new UserFacingErrorClass("error.zoom-rate");
  if (lower.includes("calendar") || lower.includes("google")) return new UserFacingErrorClass("error.zoom-calendar");
  return new UserFacingErrorClass("error.zoom-api", { message });
}
