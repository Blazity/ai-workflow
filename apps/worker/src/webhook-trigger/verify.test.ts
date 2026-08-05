import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_SIGNATURE_HEADER,
  DEFAULT_WEBHOOK_TOKEN_HEADER,
  resolveWebhookHeaderName,
  verifyWebhookAuth,
  type WebhookSecretCandidate,
} from "./verify.js";

const rawBody = '{"subject":"Printer is on fire"}';
const currentSecret = "whsec_current";
const previousSecret = "whsec_previous";

function sign(secret: string, body: string = rawBody): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const candidates: WebhookSecretCandidate[] = [
  { secret: currentSecret, verifiedWith: "current" },
  { secret: previousSecret, verifiedWith: "previous" },
];

describe("webhook auth verification", () => {
  it("accepts a bare hex digest and a sha256-prefixed one on the default header", () => {
    for (const value of [
      sign(currentSecret),
      `sha256=${sign(currentSecret)}`,
      sign(currentSecret).toUpperCase(),
    ]) {
      expect(
        verifyWebhookAuth({
          scheme: "hmac_sha256",
          headerName: null,
          rawBody,
          headers: { "x-workflow-signature": value },
          candidates,
        }),
      ).toEqual({ ok: true, verifiedWith: "current" });
    }
    expect(resolveWebhookHeaderName("hmac_sha256", null)).toBe(
      DEFAULT_WEBHOOK_SIGNATURE_HEADER,
    );
  });

  it("refuses a wrong signature, a signature over a different body, and a missing header", () => {
    const invalid = { ok: false, reason: "invalid_signature" };
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: { "x-workflow-signature": sign("whsec_someone_else") },
        candidates,
      }),
    ).toEqual(invalid);
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: { "x-workflow-signature": sign(currentSecret, '{"subject":"other"}') },
        candidates,
      }),
    ).toEqual(invalid);
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: { "x-workflow-signature": "sha256=deadbeef" },
        candidates,
      }),
    ).toEqual(invalid);
    for (const headers of [{}, { "x-workflow-signature": "   " }, { "X-Other": "x" }]) {
      expect(
        verifyWebhookAuth({
          scheme: "hmac_sha256",
          headerName: null,
          rawBody,
          headers,
          candidates,
        }),
      ).toEqual({ ok: false, reason: "missing_signature" });
    }
  });

  it("reads the configured header name case-insensitively", () => {
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: "X-Zendesk-Signature",
        rawBody,
        headers: { "x-zendesk-signature": sign(currentSecret) },
        candidates,
      }),
    ).toEqual({ ok: true, verifiedWith: "current" });
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: "X-Zendesk-Signature",
        rawBody,
        headers: { "x-workflow-signature": sign(currentSecret) },
        candidates,
      }),
    ).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("compares a shared token exactly, on its own default header", () => {
    expect(resolveWebhookHeaderName("shared_token", null)).toBe(
      DEFAULT_WEBHOOK_TOKEN_HEADER,
    );
    expect(
      verifyWebhookAuth({
        scheme: "shared_token",
        headerName: null,
        rawBody,
        headers: { "x-workflow-token": previousSecret },
        candidates,
      }),
    ).toEqual({ ok: true, verifiedWith: "previous" });
    for (const presented of [currentSecret.toUpperCase(), `${currentSecret}x`, "nope"]) {
      expect(
        verifyWebhookAuth({
          scheme: "shared_token",
          headerName: null,
          rawBody,
          headers: { "x-workflow-token": presented },
          candidates,
        }),
      ).toEqual({ ok: false, reason: "invalid_signature" });
    }
  });

  it("reports the current secret even when the rotation pair is listed the other way round", () => {
    const shared = "whsec_same_value_during_rotation";
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: { "x-workflow-signature": sign(shared) },
        candidates: [
          { secret: shared, verifiedWith: "previous" },
          { secret: shared, verifiedWith: "current" },
        ],
      }),
    ).toEqual({ ok: true, verifiedWith: "current" });
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: { "x-workflow-signature": sign(previousSecret) },
        candidates,
      }),
    ).toEqual({ ok: true, verifiedWith: "previous" });
  });

  it("refuses when no candidate secret is left to try", () => {
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: { "x-workflow-signature": sign(currentSecret) },
        candidates: [],
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });
});
