import { z } from "zod";
import { templateTopic } from "./i18n.js";
import type { MeetingTemplate } from "./models.js";
import { TEMPLATE_ALIASES } from "./parser-lexicon.js";

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const idList = z
  .string()
  .default("")
  .transform((value, context) => {
    if (value.trim() === "") return [] as number[];
    const ids = value.split(",").map((item) => Number(item.trim()));
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      context.addIssue({
        code: "custom",
        message: "ALLOWED_USERS must contain positive integer IDs separated by commas",
      });
      return z.NEVER;
    }
    return ids;
  });

const booleanEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().min(1).default("zoom-tg-bot"),
  BOT_MODE: z.enum(["polling", "webhook", "http-only"]).default("polling"),
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  PUBLIC_WEBHOOK_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().optional(),
  ),
  ALLOWED_USERS: idList,
  DATABASE_URL: z.string().min(1).default("./data/bot_state.sqlite3"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BIND_HOST: z.string().min(1).default("127.0.0.1"),
  TZ: z.string().min(1).default("Europe/Moscow"),

  ZOOM_ACCOUNT_ID: z.string().default(""),
  ZOOM_CLIENT_ID: z.string().default(""),
  ZOOM_CLIENT_SECRET: z.string().default(""),
  ZOOM_HOST_USER_ID_OR_EMAIL: z.string().default(""),
  ZOOM_AUTO_RECORDING: z
    .string()
    .default("")
    .transform((value) => value.trim().toLowerCase()),
  ZOOM_WEBHOOK_SECRET_TOKEN: z.string().default(""),
  ZOOM_WEBHOOK_PATH: z
    .string()
    .default("/zoom/webhook")
    .transform((value) => {
      const path = value.trim() || "/zoom/webhook";
      return path.startsWith("/") ? path : `/${path}`;
    }),
  ZOOM_IMAP_HOST: z.string().default(""),
  ZOOM_IMAP_PORT: z.coerce.number().int().positive().default(993),
  ZOOM_IMAP_USERNAME: z.string().default(""),
  ZOOM_IMAP_PASSWORD: z.string().default(""),
  ZOOM_IMAP_FOLDER: z.string().default("INBOX"),
  ZOOM_SUMMARY_EMAIL_FROM: z.string().default("no-reply@zoom.us"),

  GIT_NOTES_REPO_URL: z
    .string()
    .default("")
    .transform((value) => value.trim()),
  GIT_NOTES_BRANCH: z
    .string()
    .default("main")
    .transform((value) => value.trim() || "main"),
  GIT_NOTES_LOCAL_PATH: z.string().default("./data/meeting-notes"),
  GIT_AUTHOR_NAME: z
    .string()
    .default("Zoom Bot")
    .transform((value) => value.trim() || "Zoom Bot"),
  GIT_AUTHOR_EMAIL: z
    .string()
    .default("zoom-bot@local")
    .transform((value) => value.trim() || "zoom-bot@local"),

  DEFAULT_MEETING_DURATION_MINUTES: z.coerce.number().int().positive().default(60),
  QUICK_MEETING_DELAY_MINUTES: z.coerce.number().int().nonnegative().default(2),
  DEFAULT_QUICK_MEETING_TOPIC: z.string().default("Quick meeting"),
  DEFAULT_SCHEDULED_MEETING_TOPIC: z.string().default("Scheduled meeting"),
  DEFAULT_SCHEDULED_TEMPLATE: z.string().default("call"),
  TEMPLATE_QUICK_TOPIC: z.string().default("Quick meeting"),
  TEMPLATE_QUICK_DURATION_MINUTES: z.coerce.number().int().positive().default(60),
  TEMPLATE_LESSON_TOPIC: z.string().default("Lesson"),
  TEMPLATE_LESSON_DURATION_MINUTES: z.coerce.number().int().positive().default(60),
  TEMPLATE_CALL_TOPIC: z.string().default("Call"),
  TEMPLATE_CALL_DURATION_MINUTES: z.coerce.number().int().positive().default(60),
  PENDING_ACTION_TTL_MINUTES: z.coerce.number().int().positive().default(20),
  MAX_PENDING_ACTIONS: z.coerce.number().int().positive().default(200),
  REMINDER_LEAD_MINUTES: z.coerce.number().int().nonnegative().default(15),
  FOLLOWUP_DELAY_MINUTES: z.coerce.number().int().nonnegative().default(5),
  HOUSEKEEPING_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  LIST_LIMIT: z.coerce.number().int().positive().default(10),
  RECURRING_DEFAULT_WEEKLY_OCCURRENCES: z.coerce.number().int().positive().default(12),
  RECURRING_DEFAULT_MONTHLY_OCCURRENCES: z.coerce.number().int().positive().default(6),
  ZOOM_REQUEST_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  ZOOM_RETRY_BACKOFF_SECONDS: z.coerce.number().positive().default(1.5),
  ARTIFACT_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  ARTIFACT_POLL_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(180),

  MEETING_WAITING_ROOM: booleanEnv.default(false),
  MEETING_JOIN_BEFORE_HOST: booleanEnv.default(true),
  MEETING_MUTE_UPON_ENTRY: booleanEnv.default(false),
  MEETING_HOST_VIDEO: booleanEnv.default(true),
  MEETING_PARTICIPANT_VIDEO: booleanEnv.default(true),
  MEETING_USE_DEFAULT_PASSCODE: booleanEnv.default(true),
  MEETING_PASSCODE: optionalText,
});

export type AppConfig = z.infer<typeof envSchema> & {
  templates: Record<string, MeetingTemplate>;
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join("; ");
    throw new ConfigurationError(`Invalid environment configuration — ${details}`);
  }

  const config = parsed.data;
  const templates: Record<string, MeetingTemplate> = {
    quick: {
      key: "quick",
      titleKey: "template.quick.title",
      emoji: "⚡",
      aliases: TEMPLATE_ALIASES.quick,
      defaultTopic: {
        en: firstNonEmpty(
          config.TEMPLATE_QUICK_TOPIC,
          config.DEFAULT_QUICK_MEETING_TOPIC,
          templateTopic("en", "quick"),
        ),
        ru: templateTopic("ru", "quick"),
      },
      durationMinutes: config.TEMPLATE_QUICK_DURATION_MINUTES || config.DEFAULT_MEETING_DURATION_MINUTES,
    },
    lesson: {
      key: "lesson",
      titleKey: "template.lesson.title",
      emoji: "📚",
      aliases: TEMPLATE_ALIASES.lesson,
      defaultTopic: { en: config.TEMPLATE_LESSON_TOPIC, ru: templateTopic("ru", "lesson") },
      durationMinutes: config.TEMPLATE_LESSON_DURATION_MINUTES,
    },
    call: {
      key: "call",
      titleKey: "template.call.title",
      emoji: "💬",
      aliases: TEMPLATE_ALIASES.call,
      defaultTopic: {
        en: firstNonEmpty(
          config.TEMPLATE_CALL_TOPIC,
          config.DEFAULT_SCHEDULED_MEETING_TOPIC,
          templateTopic("en", "call"),
        ),
        ru: templateTopic("ru", "call"),
      },
      durationMinutes: config.TEMPLATE_CALL_DURATION_MINUTES,
    },
  };

  if (!(config.DEFAULT_SCHEDULED_TEMPLATE in templates)) {
    throw new ConfigurationError(`DEFAULT_SCHEDULED_TEMPLATE must be one of: ${Object.keys(templates).join(", ")}`);
  }

  if (config.BOT_MODE !== "http-only") {
    if (!config.TELEGRAM_BOT_TOKEN)
      throw new ConfigurationError("TELEGRAM_BOT_TOKEN is required unless BOT_MODE is http-only");
    if (config.ALLOWED_USERS.length === 0)
      throw new ConfigurationError("ALLOWED_USERS must list at least one Telegram user ID");
  }
  if (config.BOT_MODE === "webhook") {
    if (!config.TELEGRAM_WEBHOOK_SECRET)
      throw new ConfigurationError("TELEGRAM_WEBHOOK_SECRET is required in webhook mode");
    if (!config.PUBLIC_WEBHOOK_URL) throw new ConfigurationError("PUBLIC_WEBHOOK_URL is required in webhook mode");
  }

  return { ...config, templates };
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "") ?? "";
}

export function validateBotConfig(config: AppConfig): void {
  const missing: string[] = [];
  if (!config.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (config.ALLOWED_USERS.length === 0) missing.push("ALLOWED_USERS");
  missing.push(...missingZoomConfig(config));
  if (missing.length > 0) throw new ConfigurationError(`Zoom bot configuration is incomplete: ${missing.join(", ")}`);
}

export function validateZoomConfig(config: AppConfig): void {
  const missing = missingZoomConfig(config);
  if (missing.length > 0) throw new ConfigurationError(`Zoom configuration is incomplete: ${missing.join(", ")}`);
}

function missingZoomConfig(config: AppConfig): string[] {
  const fields: Array<[keyof AppConfig, string]> = [
    ["ZOOM_ACCOUNT_ID", "ZOOM_ACCOUNT_ID"],
    ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_ID"],
    ["ZOOM_CLIENT_SECRET", "ZOOM_CLIENT_SECRET"],
    ["ZOOM_HOST_USER_ID_OR_EMAIL", "ZOOM_HOST_USER_ID_OR_EMAIL"],
  ];
  return fields.filter(([key]) => !config[key]).map(([, label]) => label);
}

export function validateArtifactConfig(config: AppConfig): void {
  validateZoomConfig(config);
  if (!config.ZOOM_WEBHOOK_SECRET_TOKEN) {
    throw new ConfigurationError("ZOOM_WEBHOOK_SECRET_TOKEN is required for Zoom webhooks");
  }
}
