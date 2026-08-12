import { describe, expect, test } from "bun:test";
import { ArtifactWorker } from "../src/artifact-worker.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { createRuntimeStatus } from "../src/runtime/status.js";
import { migrateDatabase, openDatabase } from "../src/storage/database.js";
import { ZoomClient } from "../src/zoom.js";

function buildApp() {
  const config = loadConfig({ BOT_MODE: "http-only", DATABASE_URL: ":memory:" });
  const database = openDatabase(config.DATABASE_URL);
  migrateDatabase(database);
  const worker = new ArtifactWorker(config, database, new ZoomClient(config));
  return { app: createHttpApp(config, null, database, createRuntimeStatus(config.BOT_MODE), worker), database };
}

describe("HTTP runtime", () => {
  test("serves liveness and readiness", async () => {
    const { app, database } = buildApp();
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    database.close();
  });

  test("returns the service name", async () => {
    const config = loadConfig({ BOT_MODE: "http-only", APP_NAME: "demo", DATABASE_URL: ":memory:" });
    const database = openDatabase(":memory:");
    migrateDatabase(database);
    const worker = new ArtifactWorker(config, database, new ZoomClient(config));
    const response = await createHttpApp(config, null, database, createRuntimeStatus(config.BOT_MODE), worker).request(
      "/",
    );
    expect(await response.json()).toEqual({ name: "demo", status: "ok" });
    database.close();
  });
});
