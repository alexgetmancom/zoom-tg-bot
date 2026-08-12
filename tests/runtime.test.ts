import { describe, expect, test } from "bun:test";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { startIntervalWorker } from "../src/runtime/worker.js";

describe("runtime", () => {
  test("stops resources in reverse order", async () => {
    const events: string[] = [];
    const supervisor = new RuntimeSupervisor();
    supervisor.register({
      stop: () => {
        events.push("first");
      },
    });
    supervisor.register({
      stop: async () => {
        events.push("second");
      },
    });
    await supervisor.stop();
    expect(events).toEqual(["second", "first"]);
  });

  test("waits for an in-flight worker cycle", async () => {
    let finished = false;
    const worker = startIntervalWorker("test", 60_000, async () => {
      await Bun.sleep(10);
      finished = true;
    });
    await worker.stop();
    expect(finished).toBe(true);
  });
});
