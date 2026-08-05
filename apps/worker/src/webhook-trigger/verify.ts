import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_WEBHOOK_SIGNATURE_HEADER,
  DEFAULT_WEBHOOK_TIMESTAMP_HEADER,
  DEFAULT_WEBHOOK_TOKEN_HEADER,
  type WebhookAuthScheme,
} from "@shared/contracts";

/** Which of an endpoint's two live secrets authenticated a delivery. Surfaced to
 *  the operator so a rotation window can be watched to completion. */
export type WebhookVerifiedWith = "current" | "previous";

/** One secret the endpoint currently accepts. Structurally identical to what the
 *  endpoint store's decryptCandidateSecrets returns; declared here so signature
 *  checking has no dependency on storage. */
export interface WebhookSecretCandidate {
  secret: string;
  verifiedWith: WebhookVerifiedWith;
}

export interface VerifyWebhookAuthParams {
  scheme: WebhookAuthScheme;
  /** Endpoint override; null means "the scheme's default header". */
  headerName: string | null;
  /** Exactly the bytes that were signed. Never the re-serialized JSON. */
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Current secret first; the order is enforced again below. */
  candidates: WebhookSecretCandidate[];
  /** When true and the scheme is hmac_sha256, the signature must cover
   *  `${timestamp}.${rawBody}` (Stripe style) and the timestamp must be fresh.
   *  Ignored for shared_token, which has no signed message to bind. */
  requireTimestamp?: boolean;
  /** Header the timestamp is read from; null/undefined means the default. */
  timestampHeader?: string | null;
  /** Max seconds of skew tolerated on either side of `now`. Defaults to 300. */
  timestampToleranceSeconds?: number;
  /** Clock the freshness gate compares against, the DB clock at the route so a
   *  skewed worker does not silently widen the window. Defaults to now. */
  now?: Date;
}

export type VerifyWebhookAuthResult =
  | { ok: true; verifiedWith: WebhookVerifiedWith }
  | {
      ok: false;
      reason: "missing_signature" | "invalid_signature" | "stale_timestamp";
    };

// Re-exported so existing importers of these header names keep resolving them
// from verify.ts; the values themselves now live in @shared/contracts.
export {
  DEFAULT_WEBHOOK_SIGNATURE_HEADER,
  DEFAULT_WEBHOOK_TIMESTAMP_HEADER,
  DEFAULT_WEBHOOK_TOKEN_HEADER,
};

export function defaultWebhookHeaderName(scheme: WebhookAuthScheme): string {
  return scheme === "shared_token"
    ? DEFAULT_WEBHOOK_TOKEN_HEADER
    : DEFAULT_WEBHOOK_SIGNATURE_HEADER;
}

export function resolveWebhookHeaderName(
  scheme: WebhookAuthScheme,
  headerName: string | null | undefined,
): string {
  const configured = headerName?.trim();
  return configured && configured.length > 0
    ? configured
    : defaultWebhookHeaderName(scheme);
}

/** The header a timestamped delivery presents its Unix-epoch-seconds value in:
 *  the endpoint override, or the shared default when none was configured. */
export function resolveWebhookTimestampHeaderName(
  headerName: string | null | undefined,
): string {
  const configured = headerName?.trim();
  return configured && configured.length > 0
    ? configured
    : DEFAULT_WEBHOOK_TIMESTAMP_HEADER;
}

/** Default skew tolerated when the endpoint carries no explicit value. */
const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Authenticate one delivery against every secret the endpoint still accepts.
 * Returns the first match with current tried before previous, so a rotation
 * window reports the strongest secret that worked.
 *
 * Nothing here logs, and no error carries a secret, a signature, or the body:
 * the only two failure reasons are "the caller sent no credential" and "the
 * credential did not match".
 */
export function verifyWebhookAuth(params: VerifyWebhookAuthParams): VerifyWebhookAuthResult {
  const headerName = resolveWebhookHeaderName(params.scheme, params.headerName);
  const presented = readHeader(params.headers, headerName);
  if (!presented) return { ok: false, reason: "missing_signature" };

  // Optional replay protection, only for hmac_sha256: the signed message becomes
  // `${timestamp}.${rawBody}` and the timestamp must be within tolerance of now.
  // The gate runs once, before the candidate loop, so a stale delivery is refused
  // regardless of which secret it was signed with. When off, signedMessage IS the
  // raw body, so the hmac branch below is byte-identical to the pre-timestamp path.
  const useTimestamp = params.requireTimestamp === true && params.scheme === "hmac_sha256";
  let signedMessage: string | Buffer = params.rawBody;
  if (useTimestamp) {
    const rawTs = readHeader(
      params.headers,
      resolveWebhookTimestampHeaderName(params.timestampHeader),
    );
    // Missing or non-numeric reads as stale: a delivery with no honest timestamp
    // is exactly what replay protection refuses.
    if (!rawTs || !/^[0-9]+$/.test(rawTs)) {
      return { ok: false, reason: "stale_timestamp" };
    }
    const ts = Number.parseInt(rawTs, 10);
    const nowSec = Math.floor((params.now ?? new Date()).getTime() / 1000);
    const tolerance =
      params.timestampToleranceSeconds ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
    if (Math.abs(nowSec - ts) > tolerance) {
      return { ok: false, reason: "stale_timestamp" };
    }
    // The ORIGINAL header string signs, not the reparsed int, so a sender that
    // padded or spaced its value still verifies against exactly what it signed.
    signedMessage = prependSignedTimestamp(rawTs, params.rawBody);
  }

  for (const candidate of orderedCandidates(params.candidates)) {
    if (!candidate.secret) continue;
    const matches =
      params.scheme === "shared_token"
        ? constantTimeEquals(presented, candidate.secret)
        : constantTimeEquals(
            strippedHexSignature(presented),
            createHmac("sha256", candidate.secret)
              .update(signedMessage)
              .digest("hex"),
          );
    if (matches) return { ok: true, verifiedWith: candidate.verifiedWith };
  }
  return { ok: false, reason: "invalid_signature" };
}

/** `${rawTs}.${rawBody}` as the exact bytes to sign. A Buffer body keeps its raw
 *  bytes (never re-decoded) so a binary-safe sender signs what it sent. */
function prependSignedTimestamp(rawTs: string, rawBody: string | Buffer): string | Buffer {
  if (typeof rawBody === "string") return `${rawTs}.${rawBody}`;
  return Buffer.concat([Buffer.from(`${rawTs}.`, "utf8"), rawBody]);
}

/** The store yields current first, but the ordering is a security property of
 *  the answer ("which secret is still in use"), so it is not left to callers. */
function orderedCandidates(candidates: WebhookSecretCandidate[]): WebhookSecretCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.verifiedWith === b.verifiedWith) return 0;
    return a.verifiedWith === "current" ? -1 : 1;
  });
}

/** Senders differ on whether the hex digest is prefixed and cased; neither is
 *  secret, so normalizing both costs nothing and accepts the common styles. */
function strippedHexSignature(presented: string): string {
  const lowered = presented.toLowerCase();
  return lowered.startsWith("sha256=") ? lowered.slice("sha256=".length) : lowered;
}

function constantTimeEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself public
  // information: the length of a signature reveals nothing about the secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
): string | null {
  const wanted = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
