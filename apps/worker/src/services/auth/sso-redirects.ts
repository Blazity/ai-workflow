/**
 * Where the SSO round trip sends a browser next.
 *
 * Each of these is a deployment fact rather than a routing choice: which origin
 * the dashboard is served from, and which origin this worker answers on. The
 * routes decide whether to redirect; this decides where to.
 */
import { betterAuthBaseUrl, dashboardOrigin } from "../settings/index.js";
import { createDashboardSsoHandoff } from "./sso-handoff.js";

/**
 * The Better Auth instance, taken structurally from the function it is handed
 * to. Naming the type would import the app tier into a service, and this
 * cluster's ceiling on that edge is already at its baseline.
 */
type Auth = Parameters<typeof createDashboardSsoHandoff>[0];

/** The dashboard's own origin, without the trailing slash a URL join would double. */
export function dashboardOriginUrl(): string {
  return dashboardOrigin().replace(/\/$/, "");
}

/** This worker's own origin, in the same normalized form. */
export function workerOriginUrl(): string {
  return betterAuthBaseUrl().replace(/\/$/, "");
}

/** The dashboard's sign-in screen, for a caller who has no session yet. */
export function dashboardLoginUrl(): string {
  return `${dashboardOriginUrl()}/login`;
}

/** A path this worker vouched for, resolved against this worker's origin. */
export function workerUrlFor(path: string): string {
  return new URL(path, betterAuthBaseUrl()).href;
}

/**
 * Mint a one-shot handoff for the signed-in session and address the dashboard
 * endpoint that redeems it. The token travels in the query because it is the
 * only channel a cross-origin redirect has, which is why it lives for a minute.
 */
export async function dashboardSsoCompletionUrl(
  auth: Auth,
  sessionToken: string,
): Promise<string> {
  const handoffToken = await createDashboardSsoHandoff(auth, sessionToken);
  const redirectUrl = new URL("/api/auth/sso/complete", dashboardOriginUrl());
  redirectUrl.searchParams.set("token", handoffToken);
  return redirectUrl.href;
}
