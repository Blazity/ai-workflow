import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubWebhookSignature } from "./github-webhook-sig.js";

const SECRET = "test-secret";

function sign(body: string): string {
  const hex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

describe("verifyGitHubWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const body = '{"foo":"bar"}';
    expect(() => verifyGitHubWebhookSignature(body, sign(body), SECRET)).not.toThrow();
  });

  it("rejects a missing header", () => {
    expect(() => verifyGitHubWebhookSignature("x", undefined, SECRET)).toThrow(/Missing/);
  });

  it("rejects a malformed header", () => {
    expect(() => verifyGitHubWebhookSignature("x", "garbage", SECRET)).toThrow(/Malformed/);
  });

  it("rejects sha1 (legacy)", () => {
    expect(() => verifyGitHubWebhookSignature("x", "sha1=abc", SECRET)).toThrow(/Malformed/);
  });

  it("rejects an invalid signature", () => {
    const body = '{"foo":"bar"}';
    // Flip the last hex char to something different — using a constant
    // replacement could be a no-op when the original already matches it.
    const valid = sign(body);
    const lastChar = valid[valid.length - 1];
    const wrong = valid.slice(0, -1) + (lastChar === "0" ? "1" : "0");
    expect(() => verifyGitHubWebhookSignature(body, wrong, SECRET)).toThrow(/Invalid/);
  });

  it("rejects signatures of mismatched length", () => {
    expect(() => verifyGitHubWebhookSignature("x", "sha256=deadbeef", SECRET)).toThrow(/Invalid/);
  });
});
