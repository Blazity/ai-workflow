import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_SIGNATURE_HEADER,
  DEFAULT_WEBHOOK_TIMESTAMP_HEADER,
  DEFAULT_WEBHOOK_TOKEN_HEADER,
  resolveWebhookHeaderName,
  resolveWebhookTimestampHeaderName,
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

const NOW = new Date("2026-08-05T10:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

/** Sign the timestamped message `${ts}.${body}` (Stripe style). */
function signTs(
  ts: number | string,
  secret: string = currentSecret,
  body: string = rawBody,
): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

describe("webhook auth verification with timestamp replay protection", () => {
  it("accepts a fresh delivery signed over `${ts}.${body}` and the sha256= prefix", () => {
    const ts = NOW_SEC;
    for (const signature of [signTs(ts), `sha256=${signTs(ts)}`]) {
      expect(
        verifyWebhookAuth({
          scheme: "hmac_sha256",
          headerName: null,
          rawBody,
          headers: {
            "x-workflow-signature": signature,
            "x-workflow-timestamp": String(ts),
          },
          candidates,
          requireTimestamp: true,
          now: NOW,
        }),
      ).toEqual({ ok: true, verifiedWith: "current" });
    }
  });

  it("refuses a timestamp past or future of the tolerance, and accepts the exact boundary", () => {
    const base = {
      scheme: "hmac_sha256" as const,
      headerName: null,
      rawBody,
      candidates,
      requireTimestamp: true,
      now: NOW,
    };
    for (const drift of [-301, 301]) {
      const ts = NOW_SEC + drift;
      expect(
        verifyWebhookAuth({
          ...base,
          headers: {
            "x-workflow-signature": signTs(ts),
            "x-workflow-timestamp": String(ts),
          },
        }),
        String(drift),
      ).toEqual({ ok: false, reason: "stale_timestamp" });
    }
    // abs(now - ts) === tolerance is inside the window (the check is strictly >).
    for (const drift of [-300, 300]) {
      const ts = NOW_SEC + drift;
      expect(
        verifyWebhookAuth({
          ...base,
          headers: {
            "x-workflow-signature": signTs(ts),
            "x-workflow-timestamp": String(ts),
          },
        }),
        String(drift),
      ).toEqual({ ok: true, verifiedWith: "current" });
    }
  });

  it("refuses a missing or non-numeric timestamp header before trying any secret", () => {
    // Missing entirely.
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: { "x-workflow-signature": signTs(NOW_SEC) },
        candidates,
        requireTimestamp: true,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
    // Present but not a bare integer of Unix seconds.
    for (const value of ["not-a-number", "123abc", "   ", "12.5", "-100"]) {
      expect(
        verifyWebhookAuth({
          scheme: "hmac_sha256",
          headerName: null,
          rawBody,
          headers: {
            "x-workflow-signature": signTs(NOW_SEC),
            "x-workflow-timestamp": value,
          },
          candidates,
          requireTimestamp: true,
          now: NOW,
        }),
        value,
      ).toEqual({ ok: false, reason: "stale_timestamp" });
    }
  });

  it("is byte-identical when the flag is off, even with a junk timestamp header present", () => {
    // The off path must verify a body-only signature exactly as before, ignoring
    // any timestamp header entirely. This is the regression guarding the invariant.
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: {
          "x-workflow-signature": sign(currentSecret),
          "x-workflow-timestamp": "not-even-a-number",
        },
        candidates,
        now: NOW,
      }),
    ).toEqual({ ok: true, verifiedWith: "current" });
  });

  it("rejects a body-only signature once the flag is on: the signed message changed", () => {
    const ts = NOW_SEC;
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: {
          // Signed the body alone, not `${ts}.${body}`, so it no longer matches.
          "x-workflow-signature": sign(currentSecret),
          "x-workflow-timestamp": String(ts),
        },
        candidates,
        requireTimestamp: true,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("verifies a timestamped delivery against the previous secret during rotation", () => {
    const ts = NOW_SEC;
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: {
          "x-workflow-signature": signTs(ts, previousSecret),
          "x-workflow-timestamp": String(ts),
        },
        candidates,
        requireTimestamp: true,
        now: NOW,
      }),
    ).toEqual({ ok: true, verifiedWith: "previous" });
  });

  it("reads a custom timestamp header case-insensitively", () => {
    const ts = NOW_SEC;
    expect(resolveWebhookTimestampHeaderName(null)).toBe(
      DEFAULT_WEBHOOK_TIMESTAMP_HEADER,
    );
    expect(resolveWebhookTimestampHeaderName("X-Zendesk-Timestamp")).toBe(
      "X-Zendesk-Timestamp",
    );
    expect(
      verifyWebhookAuth({
        scheme: "hmac_sha256",
        headerName: null,
        rawBody,
        headers: {
          "x-workflow-signature": signTs(ts),
          "x-zendesk-timestamp": String(ts),
        },
        candidates,
        requireTimestamp: true,
        timestampHeader: "X-Zendesk-Timestamp",
        now: NOW,
      }),
    ).toEqual({ ok: true, verifiedWith: "current" });
  });

  it("honours a custom tolerance", () => {
    const ts = NOW_SEC - 3600;
    const base = {
      scheme: "hmac_sha256" as const,
      headerName: null,
      rawBody,
      headers: {
        "x-workflow-signature": signTs(ts),
        "x-workflow-timestamp": String(ts),
      },
      candidates,
      requireTimestamp: true,
      now: NOW,
    };
    // An hour old is stale under the 300s default.
    expect(verifyWebhookAuth(base)).toEqual({ ok: false, reason: "stale_timestamp" });
    // But inside a two-hour tolerance.
    expect(
      verifyWebhookAuth({ ...base, timestampToleranceSeconds: 7200 }),
    ).toEqual({ ok: true, verifiedWith: "current" });
  });

  it("ignores requireTimestamp for shared_token: there is no signed message to bind", () => {
    expect(
      verifyWebhookAuth({
        scheme: "shared_token",
        headerName: null,
        rawBody,
        headers: { "x-workflow-token": currentSecret },
        candidates,
        requireTimestamp: true,
        now: NOW,
      }),
    ).toEqual({ ok: true, verifiedWith: "current" });
  });
});
