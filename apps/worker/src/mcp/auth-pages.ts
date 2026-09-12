import { MCP_SCOPES } from "./contracts.js";

// offline_access is the standard OAuth2 / OIDC refresh-token marker, the same scope
// Atlassian and Supabase surface on their consent screens. It is deliberately not an
// MCP permission: request-context.ts materializes an actor's scope set by intersecting
// against MCP_SCOPES, so offline_access can never become one. The consent path is the
// one place it has to pass through, so the provider issues the 30-day refresh token,
// which is why the consent allowlist is MCP_SCOPES plus this single marker. Every
// consent spot (the get-gate, the rendered screen, and the post-grant) reads it through
// allowedScopes, so this one list keeps all three in agreement by construction.
const OFFLINE_ACCESS_SCOPE = "offline_access";
const CONSENT_SCOPES = [...MCP_SCOPES, OFFLINE_ACCESS_SCOPE] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

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
    .map((scope) => `<li><code>${escapeHtml(scope)}</code>${scopeDescription(scope)}</li>`)
    .join("");
  return htmlPage(
    "Authorize MCP client",
    `<main class="card" aria-labelledby="consent-title"><p class="eyebrow">MCP authorization</p><h1 id="consent-title">Authorize ${escapeHtml(input.clientName)}</h1><p class="lede">This application is requesting access to your AI Workflow account.</p><dl class="details"><div><dt>Application</dt><dd>${escapeHtml(input.clientName)}</dd></div><div><dt>Redirect host</dt><dd><code>${escapeHtml(hostname)}</code></dd></div></dl><h2>Requested access</h2><ul class="scopes">${scopeList}</ul><form method="post" action="/mcp-auth/consent"><input type="hidden" name="flow_id" value="${escapeHtml(input.flowId)}"><input type="hidden" name="scope" value="${escapeHtml(scopes.join(" "))}"><div class="actions"><button class="secondary" name="accept" value="false" type="submit">Deny</button><button class="primary" name="accept" value="true" type="submit">Allow</button></div></form></main>`,
  );
}

// offline_access is not access to any data, so the screen says what it actually does
// instead of showing a bare code the person cannot weigh. Every other scope renders as
// its code alone, exactly as before.
function scopeDescription(scope: ConsentScope): string {
  if (scope !== OFFLINE_ACCESS_SCOPE) return "";
  return "<small>Stay signed in. Lets this application refresh its own access without sending you back here. It is not access to any of your data.</small>";
}

export function allowedScopes(scopes: readonly string[]): ConsentScope[] {
  const allowed = new Set<string>(CONSENT_SCOPES);
  return [...new Set(scopes)].filter((scope): scope is ConsentScope => allowed.has(scope));
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,#fff 0,#f5f7fb 55%)}.card{width:min(100%,460px);padding:36px;border:1px solid #dfe5ef;border-radius:18px;background:#fff;box-shadow:0 18px 48px #17203314}.eyebrow{margin:0 0 10px;color:#53627a;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.lede{margin:0 0 26px;color:#53627a;line-height:1.55}h1{margin:0 0 10px;font-size:30px;letter-spacing:-.03em}h2{margin:28px 0 12px;font-size:15px}form{display:grid;gap:9px}label,dt{color:#344158;font-size:13px;font-weight:650}input{width:100%;margin:0 0 8px;padding:11px 12px;border:1px solid #cbd4e2;border-radius:9px;background:#fff;color:inherit;font:inherit}input:focus{outline:3px solid #b9d7ff;border-color:#377dcc}button,.secondary{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 16px;border-radius:9px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}.primary{border:1px solid #1f5fa8;background:#1f5fa8;color:#fff}.secondary{border:1px solid #b9c5d6;background:#fff;color:#24334d}.divider{display:flex;align-items:center;gap:12px;margin:22px 0;color:#8490a3;font-size:12px}.divider:before,.divider:after{content:"";height:1px;flex:1;background:#e3e8f0}.fine-print{margin:18px 0 0;color:#718097;font-size:12px;line-height:1.5;text-align:center}.error{margin:0 0 18px;padding:10px 12px;border:1px solid #efb9b9;border-radius:9px;background:#fff4f4;color:#a52f2f;font-size:13px}.details{display:grid;gap:12px;margin:24px 0;padding:16px;border-radius:12px;background:#f6f8fb}.details div{display:grid;gap:4px}.details dd{margin:0;color:#53627a;font-size:14px}.scopes{display:grid;gap:9px;margin:0;padding:0;list-style:none}.scopes li{padding:11px 12px;border:1px solid #e1e7f0;border-radius:9px;background:#fbfcfe}.scopes code,dd code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}.scopes small{display:block;margin-top:6px;color:#53627a;font-size:12px;line-height:1.45}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:28px}</style></head><body>${body}</body></html>`;
}
