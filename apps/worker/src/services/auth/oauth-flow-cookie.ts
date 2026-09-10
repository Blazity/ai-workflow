/**
 * The signed cookie that carries an OAuth authorization query across the consent screens.
 *
 * The MCP consent flow leaves the worker and comes back: the authorization
 * query is handed to a browser, survives a sign-in, and has to be recognized as
 * the same query on the way back. This cookie is how, and it is signed with the
 * deployment's Better Auth secret, which is why the codec lives here rather than
 * beside the pages that render the flow: reading a deployment secret is the
 * environment-dependent decision, and no route may make one.
 *
 * The secret is read here and never taken from a caller, so there is no way for
 * a page to sign a flow cookie with anything else.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { betterAuthSecret } from "../settings/index.js";

const FLOW_COOKIE = "mcp_oauth";
const FLOW_TTL_SECONDS = 10 * 60;

/**
 * Why the flow cookie could not be used. Kept as one enum with one parser behind
 * it, because the caller has to be able to LOG the distinction: on the deployed
 * worker every one of these came back as a single "OAuth request expired", and a
 * consent screen that refuses every request looked identical to a TTL problem.
 */
export type OAuthFlowCookieReason =
  | "readable"
  | "absent"
  | "malformed"
  | "bad_signature"
  | "bad_payload"
  | "flow_id_mismatch"
  | "clock_skew"
  | "expired";

/**
 * Two serverless invocations wrote and read this cookie, and they do not share a
 * clock. A strict `age < 0` therefore rejected a perfectly fresh cookie whenever
 * the reader's clock sat even milliseconds behind the writer's, which on Vercel is
 * two different function instances. A minute of tolerance keeps the replay
 * protection meaningful (the signature and the flow id are what bind the cookie to
 * the request) while surviving normal skew.
 */
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

export function createOAuthFlowCookie(
  oauthQuery: string,
  now = new Date(),
  flowId = randomUUID(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ oauthQuery, flowId, issuedAt: Math.floor(now.getTime() / 1000) }),
  ).toString("base64url");
  const signature = sign(payload);
  return `${FLOW_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${FLOW_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOAuthFlowCookie(): string {
  return `${FLOW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readOAuthFlowCookie(
  cookieHeader: string | null,
  now = new Date(),
  expectedFlowId?: string,
): string | null {
  const inspected = inspectOAuthFlowCookie(cookieHeader, now, expectedFlowId);
  return inspected.reason === "readable" ? inspected.oauthQuery : null;
}

/** The same parse, reporting which gate refused, for logs only. Never sent to a client. */
export function describeOAuthFlowCookie(
  cookieHeader: string | null,
  now = new Date(),
  expectedFlowId?: string,
): OAuthFlowCookieReason {
  return inspectOAuthFlowCookie(cookieHeader, now, expectedFlowId).reason;
}

function inspectOAuthFlowCookie(
  cookieHeader: string | null,
  now: Date,
  expectedFlowId?: string,
):
  | { reason: "readable"; oauthQuery: string }
  | { reason: Exclude<OAuthFlowCookieReason, "readable"> } {
  const encoded = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${FLOW_COOKIE}=`))
    ?.slice(FLOW_COOKIE.length + 1);
  if (!encoded) return { reason: "absent" };
  const separator = encoded.lastIndexOf(".");
  if (separator < 1) return { reason: "malformed" };
  const payload = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  const expected = sign(payload);
  if (!safeEqual(signature, expected)) return { reason: "bad_signature" };
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      oauthQuery?: unknown;
      flowId?: unknown;
      issuedAt?: unknown;
    };
    if (
      typeof value.oauthQuery !== "string" ||
      typeof value.flowId !== "string" ||
      typeof value.issuedAt !== "number"
    ) {
      return { reason: "bad_payload" };
    }
    if (expectedFlowId !== undefined && !safeEqual(value.flowId, expectedFlowId)) {
      return { reason: "flow_id_mismatch" };
    }
    const age = Math.floor(now.getTime() / 1000) - value.issuedAt;
    if (age < -CLOCK_SKEW_TOLERANCE_SECONDS) return { reason: "clock_skew" };
    if (age > FLOW_TTL_SECONDS) return { reason: "expired" };
    return { reason: "readable", oauthQuery: value.oauthQuery };
  } catch {
    return { reason: "bad_payload" };
  }
}

function sign(payload: string): string {
  return createHmac("sha256", betterAuthSecret()).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
