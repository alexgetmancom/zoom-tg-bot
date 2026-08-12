import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { buildRawSummaryMarkdown, summaryPayloadHasContent } from "../src/git-notes.js";
import { MeetingRequest } from "../src/models.js";
import { ZoomClient } from "../src/zoom.js";

const config = loadConfig({ BOT_MODE: "http-only", ZOOM_AUTO_RECORDING: "" });

describe("Zoom summary behavior", () => {
  test("prefers unified summary content", () => {
    expect(buildRawSummaryMarkdown({ summary_content: "## Key takeaways", summary_overview: "Legacy" })).toBe(
      "## Key takeaways",
    );
  });

  test("does not treat metadata-only payload as ready", () => {
    expect(
      summaryPayloadHasContent({
        summary_title: "Meeting summary",
        summary_created_time: "2026-04-22T10:00:00Z",
        summary_details: [],
        next_steps: [],
      }),
    ).toBe(false);
  });

  test("enables AI summary without enabling cloud recording", () => {
    const client = new ZoomClient(config);
    const request = new MeetingRequest("create", "call", "Demo", new Date("2026-04-22T10:00:00Z"), 60, []);
    const settings = client.buildSettings(request);
    expect(settings.auto_start_meeting_summary).toBe(true);
    expect(settings.auto_recording).toBeUndefined();
  });
});
