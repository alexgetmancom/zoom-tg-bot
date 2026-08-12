import { loadConfig, validateZoomConfig } from "./config.js";
import { templateTitle, templateTopic } from "./i18n.js";
import { DEFAULT_BOT_LOCALE } from "./locale.js";
import { MeetingRequest } from "./models.js";
import { ZoomClient } from "./zoom.js";

async function main(): Promise<void> {
  const config = loadConfig();
  validateZoomConfig(config);
  const template = config.templates.quick;
  if (!template) throw new Error("Quick meeting template is not configured");
  const startDt = new Date(Math.ceil((Date.now() + config.QUICK_MEETING_DELAY_MINUTES * 60_000) / 60_000) * 60_000);
  const request = new MeetingRequest(
    "quick",
    template.key,
    templateTopic(DEFAULT_BOT_LOCALE, template.key as "quick" | "lesson" | "call") || template.defaultTopic.en,
    startDt,
    template.durationMinutes,
    [],
    null,
    templateTitle(DEFAULT_BOT_LOCALE, template.key as "quick" | "lesson" | "call"),
  );
  const response = await new ZoomClient(config).createMeeting(request);
  console.log(response.join_url);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
