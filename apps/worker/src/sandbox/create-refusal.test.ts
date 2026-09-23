import { describe, expect, it } from "vitest";
import { sandboxCreateRefusal } from "./create-refusal.js";

// What the SDK throws for a refused request: an error whose message is only
// the status line, with the response and parsed body beside it.
function sdkRefusal(status: number, json: unknown = {}) {
  return Object.assign(new Error(`Status code ${status} is not ok`), {
    response: { status },
    json,
  });
}

describe("sandboxCreateRefusal", () => {
  it("says what failed and what to check instead of the bare status line", () => {
    const refusal = sandboxCreateRefusal(sdkRefusal(402, { message: "Usage limit reached" }));

    expect(refusal?.message).toBe(
      "A sandbox could not be created: the sandbox service refused it (HTTP 402: Usage limit reached). " +
        "Check the Vercel account's sandbox plan and usage.",
    );
    expect(refusal?.message).not.toContain("is not ok");
  });

  it("tells a rate limit apart as something to retry", () => {
    expect(sandboxCreateRefusal(sdkRefusal(429))?.message).toContain("try again shortly");
  });

  it("leaves server faults and errors without a response alone", () => {
    expect(sandboxCreateRefusal(sdkRefusal(500))).toBeNull();
    expect(sandboxCreateRefusal(new Error("socket hang up"))).toBeNull();
    expect(sandboxCreateRefusal(undefined)).toBeNull();
  });
});
