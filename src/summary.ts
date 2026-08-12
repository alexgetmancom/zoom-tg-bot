import type { JsonObject } from "./models.js";

export function buildRawSummaryMarkdown(payload: JsonObject): string {
  const content = stringValue(payload.summary_content).trim();
  return content || summaryDetailsMarkdown(payload);
}

export function summaryPayloadHasContent(payload: JsonObject): boolean {
  return Boolean(buildRawSummaryMarkdown(payload).trim());
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

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
