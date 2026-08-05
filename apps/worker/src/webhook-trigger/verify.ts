import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookAuthScheme } from "@shared/contracts";

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
}

export type VerifyWebhookAuthResult =
  | { ok: true; verifiedWith: WebhookVerifiedWith }
  | { ok: false; reason: "missing_signature" | "invalid_signature" };

export const DEFAULT_WEBHOOK_SIGNATURE_HEADER = "X-Workflow-Signature";
export const DEFAULT_WEBHOOK_TOKEN_HEADER = "X-Workflow-Token";

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

  for (const candidate of orderedCandidates(params.candidates)) {
    if (!candidate.secret) continue;
    const matches =
      params.scheme === "shared_token"
        ? constantTimeEquals(presented, candidate.secret)
        : constantTimeEquals(
            strippedHexSignature(presented),
            createHmac("sha256", candidate.secret)
              .update(params.rawBody)
              .digest("hex"),
          );
    if (matches) return { ok: true, verifiedWith: candidate.verifiedWith };
  }
  return { ok: false, reason: "invalid_signature" };
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
