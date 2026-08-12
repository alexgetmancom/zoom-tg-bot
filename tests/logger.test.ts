import { describe, expect, test } from "bun:test";
import { redact } from "../src/logger.js";

describe("redact", () => {
  test("masks nested secrets", () => {
    expect(redact({ TELEGRAM_BOT_TOKEN: "secret", nested: { password: "pass", keep: 1 } })).toEqual({
      TELEGRAM_BOT_TOKEN: "[REDACTED]",
      nested: { password: "[REDACTED]", keep: 1 },
    });
  });

  test("serializes errors and keeps primitives", () => {
    expect((redact(new Error("boom")) as { message: string }).message).toBe("boom");
    expect(redact(null)).toBeNull();
  });
});
