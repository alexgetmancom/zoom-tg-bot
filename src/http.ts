import { webhookCallback } from "grammy";
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { ArtifactWorker } from "./artifact-worker.js";
import type { BotRuntime } from "./bot/context.js";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import type { RuntimeStatus } from "./runtime/status.js";
import type { OpenDatabase } from "./storage/database.js";

export function createHttpApp(
  config: AppConfig,
  runtime: BotRuntime | null,
  database: OpenDatabase,
  status: RuntimeStatus,
  artifactWorker: ArtifactWorker,
): Hono {
  const app = new Hono();
  if (config.NODE_ENV !== "production") app.use("*", logger());
  app.get("/", (context) => context.json({ name: config.APP_NAME, status: "ok" }));
  app.get("/healthz", (context) => context.text("ok\n"));
  app.get("/readyz", (context) => {
    try {
      database.sqlite.query("SELECT 1").get();
    } catch (error) {
      log("error", "Readiness check failed", { error });
      return context.text("error\n", 500);
    }
    if (config.BOT_MODE === "polling" && !status.botReady) return context.text("not ready\n", 503);
    return context.text("ready\n");
  });

  const healthPath =
    config.ZOOM_WEBHOOK_PATH === "/" ? "/healthz" : `${config.ZOOM_WEBHOOK_PATH.replace(/\/$/, "")}/healthz`;
  app.get(healthPath, (context) =>
    context.json({
      status: "ok",
      meeting_summary_api_enabled: true,
      imap_enabled: artifactWorker.imapEnabled,
      git_notes_enabled: artifactWorker.gitNotesEnabled,
    }),
  );
  app.post(config.ZOOM_WEBHOOK_PATH, async (context) =>
    artifactWorker.handleWebhook(new Uint8Array(await context.req.raw.arrayBuffer()), context.req.raw.headers),
  );

  if (config.BOT_MODE === "webhook" && runtime) {
    if (!config.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET is required in webhook mode");
    app.post(
      "/telegram/webhook",
      webhookCallback(runtime.bot, "hono", { secretToken: config.TELEGRAM_WEBHOOK_SECRET }),
    );
  }
  app.onError((error, context) => {
    log("error", "Unhandled HTTP error", { error, path: context.req.path });
    return context.json({ error: "Internal Server Error" }, 500);
  });
  return app;
}
