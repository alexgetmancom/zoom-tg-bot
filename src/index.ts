import { ArtifactWorker } from "./artifact-worker.js";
import { configureBot, createBot, runReminderCycle } from "./bot/bot.js";
import { loadConfig, validateBotConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { log } from "./logger.js";
import { stopServerGracefully } from "./runtime/shutdown.js";
import { createRuntimeStatus } from "./runtime/status.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startIntervalWorker } from "./runtime/worker.js";
import { migrateDatabase, openDatabase } from "./storage/database.js";
import { ZoomClient } from "./zoom.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.BOT_MODE !== "http-only") validateBotConfig(config);
  const database = openDatabase(config.DATABASE_URL);
  migrateDatabase(database);
  const runtime = config.BOT_MODE === "http-only" ? null : createBot(config, database);
  const zoom = runtime?.zoom ?? new ZoomClient(config);
  const artifactWorker = new ArtifactWorker(config, database, zoom);
  const status = createRuntimeStatus(config.BOT_MODE);
  const app = createHttpApp(config, runtime, database, status, artifactWorker);
  const server = Bun.serve({ fetch: app.fetch, hostname: config.BIND_HOST, port: config.PORT });
  const supervisor = new RuntimeSupervisor();
  supervisor.register(
    startIntervalWorker("telegram-reminders", config.HOUSEKEEPING_INTERVAL_SECONDS * 1000, async () => {
      if (runtime) await runReminderCycle(runtime);
    }),
  );
  supervisor.register(
    startIntervalWorker("zoom-artifacts", config.ARTIFACT_POLL_INTERVAL_SECONDS * 1000, () =>
      artifactWorker.processCycle(),
    ),
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log("info", "Stopping service", { signal });
    await supervisor.stop();
    if (runtime?.bot.isRunning()) await runtime.bot.stop();
    await stopServerGracefully(server);
    database.close();
    log("info", "Service stopped");
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (runtime) {
    try {
      await configureBot(runtime.bot);
    } catch (error) {
      log("warn", "Failed to configure Telegram commands", { error });
    }
  }

  if (config.BOT_MODE === "polling" && runtime) {
    void runtime.bot
      .start({
        drop_pending_updates: true,
        onStart: (botInfo) => {
          status.botReady = true;
          status.botError = null;
          log("info", "Telegram polling started", { username: botInfo.username });
        },
      })
      .catch(async (error) => {
        status.botReady = false;
        status.botError = error instanceof Error ? error.message : String(error);
        log("error", "Telegram polling stopped unexpectedly", { error });
        await shutdown("TELEGRAM_POLLING_FAILED");
        process.exitCode = 1;
      });
  } else if (config.BOT_MODE === "webhook" && runtime) {
    const secret = config.TELEGRAM_WEBHOOK_SECRET;
    const publicUrl = config.PUBLIC_WEBHOOK_URL;
    if (!secret || !publicUrl) throw new Error("Webhook configuration is incomplete");
    await runtime.bot.api.setWebhook(`${publicUrl}/telegram/webhook`, { secret_token: secret });
    log("info", "Telegram webhook registered", { url: `${publicUrl}/telegram/webhook` });
  } else {
    log("info", "HTTP-only mode enabled");
  }
  log("info", "HTTP server listening", { address: `http://${config.BIND_HOST}:${config.PORT}`, mode: config.BOT_MODE });
}

void main().catch((error) => {
  log("error", "Service startup failed", { error });
  process.exitCode = 1;
});
