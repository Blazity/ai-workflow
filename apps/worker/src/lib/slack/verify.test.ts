import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "./verify.js";

const SIGNING_SECRET = "shhhh-do-not-tell";

function sign(rawBody: string, timestamp: string, secret = SIGNING_SECRET): string {
  const mac = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return `v0=${mac}`;
}

describe("verifySlackSignature", () => {
  it("returns true for a valid signature within the replay window", () => {
    const rawBody = "command=%2Fblazebot&text=list";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(rawBody, timestamp);

    expect(
      verifySlackSignature({
        rawBody,
        timestamp,
        signature,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(true);
  });

  it("returns false when the body has been tampered", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign("original", timestamp);

    expect(
      verifySlackSignature({
        rawBody: "tampered",
        timestamp,
        signature,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  it("returns false when the timestamp is older than 5 minutes", () => {
    const rawBody = "ok";
    const tooOld = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const signature = sign(rawBody, tooOld);

    expect(
      verifySlackSignature({
        rawBody,
        timestamp: tooOld,
        signature,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  it("returns false when the timestamp is in the far future", () => {
    const rawBody = "ok";
    const tooNew = String(Math.floor(Date.now() / 1000) + 10 * 60);
    const signature = sign(rawBody, tooNew);

    expect(
      verifySlackSignature({
        rawBody,
        timestamp: tooNew,
        signature,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  it("returns false on a length-mismatched signature without throwing", () => {
    const rawBody = "ok";
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(() =>
      verifySlackSignature({
        rawBody,
        timestamp,
        signature: "v0=short",
        signingSecret: SIGNING_SECRET,
      }),
    ).not.toThrow();
    expect(
      verifySlackSignature({
        rawBody,
        timestamp,
        signature: "v0=short",
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  it("returns false when the signature is missing the v0= prefix", () => {
    const rawBody = "ok";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(rawBody, timestamp).slice("v0=".length);

    expect(
      verifySlackSignature({
        rawBody,
        timestamp,
        signature,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  it("returns false when the timestamp is not a valid integer", () => {
    expect(
      verifySlackSignature({
        rawBody: "ok",
        timestamp: "not-a-number",
        signature: "v0=deadbeef",
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });
});
