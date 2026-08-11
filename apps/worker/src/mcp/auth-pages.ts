import { createHmac, timingSafeEqual } from "node:crypto";

import { MCP_SCOPES, type McpScope } from "./contracts.js";

const FLOW_COOKIE = "mcp_oauth";
const FLOW_TTL_SECONDS = 10 * 60;

export function safeOAuthReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/api/auth/oauth2/authorize?")) {
    return null;
  }
  const rawPath = value.slice(0, value.indexOf("?"));
  if (/%2e|%2f|%5c/i.test(rawPath)) return null;
  try {
    const parsed = new URL(value, "https://worker.invalid");
    if (parsed.origin !== "https://worker.invalid") return null;
    if (parsed.pathname !== "/api/auth/oauth2/authorize" || !parsed.search) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function createOAuthFlowCookie(
  oauthQuery: string,
  secret: string,
  now = new Date(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ oauthQuery, issuedAt: Math.floor(now.getTime() / 1000) }),
  ).toString("base64url");
  const signature = sign(payload, secret);
  return `${FLOW_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${FLOW_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOAuthFlowCookie(): string {
  return `${FLOW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readOAuthFlowCookie(
  cookieHeader: string | null,
  secret: string,
  now = new Date(),
): string | null {
  const encoded = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${FLOW_COOKIE}=`))
    ?.slice(FLOW_COOKIE.length + 1);
  if (!encoded) return null;
  const separator = encoded.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  const expected = sign(payload, secret);
  if (!safeEqual(signature, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      oauthQuery?: unknown;
      issuedAt?: unknown;
    };
    if (typeof value.oauthQuery !== "string" || typeof value.issuedAt !== "number") return null;
    const age = Math.floor(now.getTime() / 1000) - value.issuedAt;
    if (age < 0 || age > FLOW_TTL_SECONDS) return null;
    return value.oauthQuery;
  } catch {
    return null;
  }
}

export function renderMcpLoginPage(input: { error?: string | null }): string {
  const error = input.error
    ? `<p role="alert">${escapeHtml(input.error)}</p>`
    : "";
  return htmlPage(
    "Sign in to AI Workflow",
    `<main><h1>Sign in to AI Workflow</h1>${error}<form method="post" action="/mcp-auth/login"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form><p><a href="/api/dashboard-auth/sso/start?oauth=1">Continue with SSO</a></p></main>`,
  );
}

export function renderMcpConsentPage(input: {
  clientName: string;
  redirectUri: string;
  requestedScopes: readonly string[];
}): string {
  const hostname = safeHostname(input.redirectUri);
  const scopes = allowedScopes(input.requestedScopes);
  const scopeList = scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
  return htmlPage(
    "Authorize MCP client",
    `<main><h1>Authorize ${escapeHtml(input.clientName)}</h1><p>Redirect host: <strong>${escapeHtml(hostname)}</strong></p><ul>${scopeList}</ul><form method="post" action="/mcp-auth/consent"><input type="hidden" name="scope" value="${escapeHtml(scopes.join(" "))}"><button name="accept" value="true" type="submit">Allow</button><button name="accept" value="false" type="submit">Deny</button></form></main>`,
  );
}

export function allowedScopes(scopes: readonly string[]): McpScope[] {
  const allowed = new Set<string>(MCP_SCOPES);
  return [...new Set(scopes)].filter((scope): scope is McpScope => allowed.has(scope));
}

export function isSameOriginPost(request: Request, expectedOrigin: string): boolean {
  if (request.method !== "POST") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "invalid redirect";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}
