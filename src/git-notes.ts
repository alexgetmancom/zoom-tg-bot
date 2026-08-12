import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import type { JsonObject, MeetingRecord } from "./models.js";
import { formatDateTimeWithYear } from "./time.js";

export function sanitizePathComponent(value: string): string {
  const cleaned = [...value.trim().toLowerCase()].map((char) => (/^[\p{L}\p{N}]$/u.test(char) ? char : "-")).join("");
  return cleaned.split("-").filter(Boolean).join("-").slice(0, 80) || "meeting";
}

function summaryDetailsMarkdown(payload: JsonObject): string {
  const lines: string[] = [];
  const overview = stringValue(payload.summary_overview).trim();
  if (overview) lines.push("### Overview", "", overview, "");
  const details = arrayValue(payload.summary_details);
  if (details.length > 0) {
    lines.push("### Topics", "");
    for (const item of details) {
      if (!isObject(item)) continue;
      const label = stringValue(item.label).trim();
      const summary = stringValue(item.summary).trim();
      if (label) lines.push(`#### ${label}`);
      if (summary) lines.push(summary);
      if (label || summary) lines.push("");
    }
  }
  const nextSteps = arrayValue(payload.next_steps);
  if (nextSteps.length > 0) {
    lines.push("### Next Steps", "");
    for (const step of nextSteps) {
      const text = stringValue(step).trim();
      if (text) lines.push(`- ${text}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function buildRawSummaryMarkdown(payload: JsonObject): string {
  const content = stringValue(payload.summary_content).trim();
  return content || summaryDetailsMarkdown(payload);
}

export function summaryPayloadHasContent(payload: JsonObject): boolean {
  return Boolean(buildRawSummaryMarkdown(payload).trim());
}

export function buildGitNotePath(config: AppConfig, record: MeetingRecord): string {
  if (record.gitNotePath) return record.gitNotePath;
  const localDate = localDateParts(record.startDt, config.TZ);
  const slug = sanitizePathComponent(record.topic);
  const fileName = `${localDate.year}-${String(localDate.month).padStart(2, "0")}-${String(localDate.day).padStart(2, "0")}_${String(localDate.hour).padStart(2, "0")}${String(localDate.minute).padStart(2, "0")}_${slug}_${record.zoomMeetingId}.md`;
  return `${localDate.year}/${String(localDate.month).padStart(2, "0")}/${fileName}`;
}

export function renderGitMeetingNote(config: AppConfig, record: MeetingRecord, payload: JsonObject): string {
  const summaryContent = stringValue(payload.summary_content).trim();
  const summaryOverview = stringValue(payload.summary_overview).trim();
  const summaryDetails = arrayValue(payload.summary_details);
  const nextSteps = arrayValue(payload.next_steps);
  const rawSummary = buildRawSummaryMarkdown(payload);
  const lines = [
    "---",
    'schema: "zoom-meeting-note-v1"',
    `topic: ${yamlString(record.topic)}`,
    `zoom_meeting_id: ${yamlString(record.zoomMeetingId)}`,
    `zoom_meeting_uuid: ${yamlString(record.zoomMeetingUuid ?? "")}`,
    `start_at: ${yamlString(record.startDt.toISOString())}`,
    `timezone: ${yamlString(record.timezoneName)}`,
    `duration_minutes: ${record.durationMinutes}`,
    `template_key: ${yamlString(record.templateKey)}`,
    `status: ${yamlString(record.status)}`,
    `calendar_push_requested: ${record.calendarPushRequested ? "true" : "false"}`,
    `recording_status: ${yamlString(record.recordingStatus ?? "")}`,
    `summary_created_time: ${yamlString(stringValue(payload.summary_created_time))}`,
    `summary_last_modified_time: ${yamlString(stringValue(payload.summary_last_modified_time))}`,
    `source_query: ${yamlString(record.sourceRequest.sourceQuery)}`,
    'telegram_source: "inline"',
    'client_ref: ""',
    'chat_ref: ""',
    "invitee_emails:",
  ];
  if (record.inviteeEmails.length > 0) lines.push(...record.inviteeEmails.map((email) => `  - ${yamlString(email)}`));
  else lines.push("  []");
  lines.push(
    "---",
    "",
    `# ${record.topic}`,
    "",
    `- Date: ${formatDateTimeWithYear(record.startDt, config.TZ)}`,
    `- Template: ${record.templateKey}`,
    `- Zoom ID: \`${record.zoomMeetingId}\``,
    "",
  );

  if (summaryContent) {
    lines.push("## Summary", "", summaryContent, "");
  } else {
    lines.push("## Overview", "", summaryOverview || "_Zoom returned no overview._", "", "## Topics", "");
    if (summaryDetails.length > 0) {
      for (const item of summaryDetails) {
        if (!isObject(item)) continue;
        lines.push(
          `### ${stringValue(item.label).trim() || "Topic"}`,
          "",
          stringValue(item.summary).trim() || "_Zoom returned no details._",
          "",
        );
      }
    } else lines.push("_Zoom returned no topic breakdown._", "");
    lines.push("## Next Steps", "");
    const renderedSteps = nextSteps.map((step) => stringValue(step).trim()).filter(Boolean);
    lines.push(
      ...(renderedSteps.length > 0 ? renderedSteps.map((step) => `- ${step}`) : ["_Zoom returned no next steps._"]),
    );
    lines.push("", "## Raw Zoom Summary", "", rawSummary || "_Empty raw summary._", "");
  }
  return lines.join("\n");
}

export class GitNotesExporter {
  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.GIT_NOTES_REPO_URL);
  }

  exportSummary(record: MeetingRecord, payload: JsonObject): { notePath: string; commitSha: string | null } {
    const repoPath = this.ensureRepo();
    const notePath = buildGitNotePath(this.config, record);
    const absolutePath = join(repoPath, notePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, renderGitMeetingNote(this.config, record, payload), "utf8");
    log("info", "Git meeting note export requested", {
      recordId: record.recordId,
      notePath,
      branch: this.config.GIT_NOTES_BRANCH,
    });
    this.runGit(["add", notePath], repoPath);
    const staged = this.runGit(["diff", "--cached", "--name-only"], repoPath);
    if (!staged.trim()) return { notePath, commitSha: this.tryGit(["rev-parse", "HEAD"], repoPath) };
    this.runGit(
      [
        "commit",
        "-m",
        `Update meeting note: ${record.topic} (${formatDateTimeWithYear(record.startDt, this.config.TZ)})`,
      ],
      repoPath,
    );
    this.runGit(["push", "-u", "origin", this.config.GIT_NOTES_BRANCH], repoPath);
    return { notePath, commitSha: this.runGit(["rev-parse", "HEAD"], repoPath).trim() || null };
  }

  private ensureRepo(): string {
    const repoPath = this.config.GIT_NOTES_LOCAL_PATH;
    mkdirSync(repoPath, { recursive: true });
    if (!existsSync(join(repoPath, ".git"))) {
      this.runGit(["init", "-b", this.config.GIT_NOTES_BRANCH], repoPath);
      this.runGit(["remote", "add", "origin", this.config.GIT_NOTES_REPO_URL], repoPath);
    } else if (!this.tryGit(["remote", "get-url", "origin"], repoPath)) {
      this.runGit(["remote", "add", "origin", this.config.GIT_NOTES_REPO_URL], repoPath);
    }
    this.runGit(["checkout", "-B", this.config.GIT_NOTES_BRANCH], repoPath);
    if (this.tryGit(["ls-remote", "--heads", "origin", this.config.GIT_NOTES_BRANCH], repoPath)) {
      this.runGit(["fetch", "origin", this.config.GIT_NOTES_BRANCH], repoPath);
      this.runGit(["pull", "--ff-only", "origin", this.config.GIT_NOTES_BRANCH], repoPath);
    }
    return repoPath;
  }

  private runGit(args: string[], cwd: string): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: this.config.GIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: this.config.GIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: this.config.GIT_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: this.config.GIT_AUTHOR_EMAIL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  private tryGit(args: string[], cwd: string): string | null {
    try {
      return this.runGit(args, cwd);
    } catch {
      return null;
    }
  }
}

function yamlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}
