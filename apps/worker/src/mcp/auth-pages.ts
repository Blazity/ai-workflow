import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { MCP_SCOPES, type McpScope } from "./contracts.js";

const FLOW_COOKIE = "mcp_oauth";
const FLOW_TTL_SECONDS = 10 * 60;

export function isOAuthAuthorizationQuery(query: URLSearchParams): boolean {
  return Boolean(
    query.get("client_id") &&
      query.get("redirect_uri") &&
      query.get("response_type"),
  );
}

export function isOpaqueHandoffToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,256}$/.test(value);
}

export function oauthConsentUrl(oauthQuery: string, workerOrigin: string): string {
  const url = new URL("/mcp-auth/consent", workerOrigin);
  url.search = `?${oauthQuery}`;
  return url.href;
}

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
  flowId = randomUUID(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ oauthQuery, flowId, issuedAt: Math.floor(now.getTime() / 1000) }),
  ).toString("base64url");
  const signature = sign(payload, secret);
  return `${FLOW_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${FLOW_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOAuthFlowCookie(): string {
  return `${FLOW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

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

export function readOAuthFlowCookie(
  cookieHeader: string | null,
  secret: string,
  now = new Date(),
  expectedFlowId?: string,
): string | null {
  const inspected = inspectOAuthFlowCookie(cookieHeader, secret, now, expectedFlowId);
  return inspected.reason === "readable" ? inspected.oauthQuery : null;
}

/** The same parse, reporting which gate refused, for logs only. Never sent to a client. */
export function describeOAuthFlowCookie(
  cookieHeader: string | null,
  secret: string,
  now = new Date(),
  expectedFlowId?: string,
): OAuthFlowCookieReason {
  return inspectOAuthFlowCookie(cookieHeader, secret, now, expectedFlowId).reason;
}

function inspectOAuthFlowCookie(
  cookieHeader: string | null,
  secret: string,
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
  const expected = sign(payload, secret);
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

export function renderMcpLoginPage(input: { error?: string | null }): string {
  const error = input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : "";
  return htmlPage(
    "Sign in to AI Workflow",
    `<main class="card" aria-labelledby="login-title"><p class="eyebrow">AI Workflow</p><h1 id="login-title">Sign in to continue</h1><p class="lede">Sign in to review and authorize this MCP connection.</p>${error}<form method="post" action="/mcp-auth/login"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button class="primary" type="submit">Sign in</button></form><div class="divider" role="presentation"><span>or</span></div><a class="secondary" href="/api/dashboard-auth/sso/start?oauth=1">Continue with SSO</a><p class="fine-print">You can return to your agent after signing in.</p></main>`,
  );
}

export function renderMcpConsentPage(input: {
  clientName: string;
  redirectUri: string;
  requestedScopes: readonly string[];
  flowId: string;
}): string {
  const hostname = safeHostname(input.redirectUri);
  const scopes = allowedScopes(input.requestedScopes);
  const scopeList = scopes
    .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join("");
  return htmlPage(
    "Authorize MCP client",
    `<main class="card" aria-labelledby="consent-title"><p class="eyebrow">MCP authorization</p><h1 id="consent-title">Authorize ${escapeHtml(input.clientName)}</h1><p class="lede">This application is requesting access to your AI Workflow account.</p><dl class="details"><div><dt>Application</dt><dd>${escapeHtml(input.clientName)}</dd></div><div><dt>Redirect host</dt><dd><code>${escapeHtml(hostname)}</code></dd></div></dl><h2>Requested access</h2><ul class="scopes">${scopeList}</ul><form method="post" action="/mcp-auth/consent"><input type="hidden" name="flow_id" value="${escapeHtml(input.flowId)}"><input type="hidden" name="scope" value="${escapeHtml(scopes.join(" "))}"><div class="actions"><button class="secondary" name="accept" value="false" type="submit">Deny</button><button class="primary" name="accept" value="true" type="submit">Allow</button></div></form></main>`,
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,#fff 0,#f5f7fb 55%)}.card{width:min(100%,460px);padding:36px;border:1px solid #dfe5ef;border-radius:18px;background:#fff;box-shadow:0 18px 48px #17203314}.eyebrow{margin:0 0 10px;color:#53627a;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.lede{margin:0 0 26px;color:#53627a;line-height:1.55}h1{margin:0 0 10px;font-size:30px;letter-spacing:-.03em}h2{margin:28px 0 12px;font-size:15px}form{display:grid;gap:9px}label,dt{color:#344158;font-size:13px;font-weight:650}input{width:100%;margin:0 0 8px;padding:11px 12px;border:1px solid #cbd4e2;border-radius:9px;background:#fff;color:inherit;font:inherit}input:focus{outline:3px solid #b9d7ff;border-color:#377dcc}button,.secondary{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 16px;border-radius:9px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}.primary{border:1px solid #1f5fa8;background:#1f5fa8;color:#fff}.secondary{border:1px solid #b9c5d6;background:#fff;color:#24334d}.divider{display:flex;align-items:center;gap:12px;margin:22px 0;color:#8490a3;font-size:12px}.divider:before,.divider:after{content:"";height:1px;flex:1;background:#e3e8f0}.fine-print{margin:18px 0 0;color:#718097;font-size:12px;line-height:1.5;text-align:center}.error{margin:0 0 18px;padding:10px 12px;border:1px solid #efb9b9;border-radius:9px;background:#fff4f4;color:#a52f2f;font-size:13px}.details{display:grid;gap:12px;margin:24px 0;padding:16px;border-radius:12px;background:#f6f8fb}.details div{display:grid;gap:4px}.details dd{margin:0;color:#53627a;font-size:14px}.scopes{display:grid;gap:9px;margin:0;padding:0;list-style:none}.scopes li{padding:11px 12px;border:1px solid #e1e7f0;border-radius:9px;background:#fbfcfe}.scopes code,dd code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:28px}</style></head><body>${body}</body></html>`;
}
