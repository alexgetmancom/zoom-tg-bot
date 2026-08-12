import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseZoomTranscriptVtt } from "./artifact-worker.js";
import { loadConfig, validateZoomConfig } from "./config.js";
import { buildRawSummaryMarkdown, summaryPayloadHasContent } from "./git-notes.js";
import type { JsonObject } from "./models.js";
import { formatDateTimeWithYear } from "./time.js";
import { ZoomClient } from "./zoom.js";

type SummaryItem = JsonObject;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  validateZoomConfig(config);
  const client = new ZoomClient(config);
  const from = parseDay(args.from);
  const to = new Date(parseDay(args.to).getTime() + 86_400_000 - 1);
  const outDir = args.outDir || join(process.cwd(), "exports", `meeting-summaries_${args.from}_${args.to}`);
  mkdirSync(outDir, { recursive: true });
  const items = await listSummaryItems(client, from, to);
  const manifest: JsonObject[] = [];

  for (const item of items) {
    const uuid = stringValue(item.meeting_uuid);
    if (!uuid) continue;
    const payload = await client.getMeetingSummary(uuid);
    const base = buildExportBaseName(config, item);
    const summaryPath = join(outDir, `${base}_zoom-summary.md`);
    const content = [
      `# ${stringValue(payload.summary_title) || "Zoom AI Companion Summary"}`,
      "",
      `Meeting: ${stringValue(item.meeting_topic)}`,
      `Meeting ID: ${stringValue(item.meeting_id)}`,
      `When: ${formatLocal(config, stringValue(item.meeting_start_time))}`,
      "",
      "Source: Zoom Meeting Summary API",
      "",
      summaryPayloadHasContent(payload) ? buildRawSummaryMarkdown(payload) : "_No summary body returned by Zoom._",
      "",
    ].join("\n");
    writeFileSync(summaryPath, content, "utf8");
    const transcriptPath = await saveTranscript(client, config, outDir, item, base);
    manifest.push({
      meeting_id: item.meeting_id,
      meeting_uuid: uuid,
      meeting_topic: item.meeting_topic,
      meeting_start_time: item.meeting_start_time,
      summary_file: summaryPath,
      transcript_file: transcriptPath,
    });
  }

  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Exported ${manifest.length} meeting summaries to ${outDir}`);
  console.log(`Manifest: ${manifestPath}`);
}

async function listSummaryItems(client: ZoomClient, from: Date, to: Date): Promise<SummaryItem[]> {
  const items: SummaryItem[] = [];
  let token: string | undefined;
  do {
    const payload = await client.listMeetingSummaries(from, to, 100, token);
    if (Array.isArray(payload.summaries)) items.push(...payload.summaries.filter(isObject));
    token = stringValue(payload.next_page_token) || undefined;
  } while (token);
  return items;
}

async function saveTranscript(
  client: ZoomClient,
  config: ReturnType<typeof loadConfig>,
  outDir: string,
  item: SummaryItem,
  base: string,
): Promise<string | null> {
  const uuid = stringValue(item.meeting_uuid);
  if (!uuid) return null;
  try {
    const recordings = await client.getMeetingRecordings(uuid, true);
    const files = Array.isArray(recordings.recording_files) ? recordings.recording_files : [];
    const file = files.find(
      (entry) =>
        isObject(entry) &&
        (stringValue(entry.file_type).toUpperCase() === "TRANSCRIPT" ||
          stringValue(entry.file_extension).toUpperCase() === "VTT" ||
          stringValue(entry.recording_type).toLowerCase().includes("transcript")),
    );
    const url = isObject(file) ? stringValue(file.download_url) : "";
    if (!url) return null;
    const transcript = parseZoomTranscriptVtt(await client.downloadRecordingFile(url));
    if (!transcript) return null;
    const path = join(outDir, `${base}_transcript.txt`);
    writeFileSync(
      path,
      `Meeting: ${stringValue(item.meeting_topic)}\nMeeting ID: ${stringValue(item.meeting_id)}\nWhen: ${formatLocal(config, stringValue(item.meeting_start_time))}\n\n${transcript}\n`,
      "utf8",
    );
    return path;
  } catch {
    return null;
  }
}

function parseArgs(args: string[]): { from: string; to: string; outDir?: string } {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--from" || argument === "--to" || argument === "--out-dir") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      values[argument.slice(2)] = value;
      index += 1;
    }
  }
  if (!values.from || !values.to)
    throw new Error("Usage: bun run src/export-summaries.ts --from YYYY-MM-DD --to YYYY-MM-DD [--out-dir DIR]");
  parseDay(values.from);
  parseDay(values.to);
  return { from: values.from, to: values.to, ...(values["out-dir"] ? { outDir: values["out-dir"] } : {}) };
}

function parseDay(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function buildExportBaseName(config: ReturnType<typeof loadConfig>, item: SummaryItem): string {
  const date = new Date(stringValue(item.meeting_start_time));
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const topic =
    stringValue(item.meeting_topic)
      .trim()
      .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
      .replace(/^[._]+|[._]+$/g, "")
      .slice(0, 80) || "meeting";
  return `${values.year}-${values.month}-${values.day}_${values.hour}${values.minute}_${topic}`;
}

function formatLocal(config: ReturnType<typeof loadConfig>, value: string): string {
  return formatDateTimeWithYear(new Date(value), config.TZ);
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
