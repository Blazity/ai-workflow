import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyJiraWebhookSignature } from "./jira.js";

describe("verifyJiraWebhookSignature", () => {
  const secret = "test-secret";
  const body = Buffer.from('{"test":true}');
  const validSig =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("returns true for a valid signature", () => {
    expect(verifyJiraWebhookSignature(body, validSig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    expect(verifyJiraWebhookSignature(body, "sha256=bad", secret)).toBe(false);
  });

  it("returns false when signature is undefined", () => {
    expect(verifyJiraWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("returns false when body has been tampered with", () => {
    const tampered = Buffer.from('{"test":false}');
    expect(verifyJiraWebhookSignature(tampered, validSig, secret)).toBe(false);
  });
});
