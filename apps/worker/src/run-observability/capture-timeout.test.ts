import { describe, expect, it } from "vitest";
import { replayCaptureWithinTimeout } from "./capture-timeout.js";

describe("replayCaptureWithinTimeout", () => {
  it("returns a capture result before the deadline", async () => {
    await expect(
      replayCaptureWithinTimeout(Promise.resolve("captured"), 10),
    ).resolves.toBe("captured");
  });

  it("bounds a stalled best-effort capture", async () => {
    await expect(
      replayCaptureWithinTimeout(new Promise(() => {}), 5),
    ).rejects.toThrow("Replay capture timed out");
  });
});
