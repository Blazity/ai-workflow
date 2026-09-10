import { describe, expect, it } from "vitest";
import { BLOCK_PARAM_SCHEMAS } from "../../definition/params.generated.js";

describe("trigger_webhook paramsSchema", () => {
  it("reports the exact replay-protection diagnostic through the generated map", () => {
    const result = BLOCK_PARAM_SCHEMAS.trigger_webhook.safeParse({
      authScheme: "shared_token",
      requireTimestamp: true,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ["requireTimestamp"],
        message: "Replay protection requires the HMAC SHA-256 scheme.",
      },
    ]);
  });
});
