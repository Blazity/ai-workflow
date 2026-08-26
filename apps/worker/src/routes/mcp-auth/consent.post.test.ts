// The POST half of the consent screen, which had no cover at all: AIW-270 was
// fixed for GET, the page rendered, and then every POST answered
// 400 "OAuth request expired" on production. Three different failures share that
// one message, so this file drives the REAL handoff (GET sets the cookie and
// renders the flow id, POST sends both back) rather than hand-building a cookie.
import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  prelogin: vi.fn(),
  authHandler: vi.fn(),
  loggerWarn: vi.fn(),
  env: {
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "https://worker.example.com",
  },
}));

vi.mock("../../../env.js", () => ({
  env: state.env,
}));

vi.mock("../../auth-instance.js", () => ({
  auth: {
    handler: state.authHandler,
    api: {
      getOAuthClientPublicPrelogin: state.prelogin,
    },
  },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: state.loggerWarn },
}));

const consentGet = (await import("./consent.get.js")).default;
const consentPost = (await import("./consent.post.js")).default;

const CLIENT_ID = "eiWzIXwrrXzrZboIhhEFKalUtICrwHCe";
const REDIRECT_URI = "http://127.0.0.1:43110/callback";

beforeEach(() => {
  vi.clearAllMocks();
  state.prelogin.mockResolvedValue({
    client_id: CLIENT_ID,
    client_name: "aiw-dogfood-pkce",
    redirect_uris: [],
  });
  state.authHandler.mockResolvedValue(
    Response.json({ url: `${REDIRECT_URI}?code=the-code&state=probe` }),
  );
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function consentUrl(overrides: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "mcp:read runs:dispatch",
    state: "probe",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    exp: "1786597132",
    ba_iat: "1786596532923",
    sig: "0e6g9sZI2vvfQEnndJjoGGfdPi2kfBu9W21XvBmGbe4=",
    ...overrides,
  });
  return `https://worker.example.com/mcp-auth/consent?${query.toString()}`;
}

/** Walks the browser's half: render the page, then post the form it rendered. */
async function renderThenApprove(accept = "true", url = consentUrl()) {
  const rendered = await handlerFor(consentGet)(new Request(url));
  expect(rendered.status).toBe(200);
  const html = await rendered.text();
  const setCookie = rendered.headers.get("set-cookie") ?? "";
  const cookieValue = setCookie.split(";")[0] ?? "";
  const flowId = /name="flow_id" value="([^"]+)"/.exec(html)?.[1];
  const scope = /name="scope" value="([^"]+)"/.exec(html)?.[1];
  expect(flowId).toBeTruthy();
  expect(scope).toBeTruthy();

  const body = new URLSearchParams({
    flow_id: String(flowId),
    scope: String(scope),
    accept,
  });
  const response = await handlerFor(consentPost)(
    new Request("https://worker.example.com/mcp-auth/consent", {
      method: "POST",
      headers: {
        origin: "https://worker.example.com",
        cookie: cookieValue,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    }),
  );
  return { response, flowId, cookieValue };
}

describe("MCP consent POST", () => {
  it("approves the flow the page just rendered", async () => {
    const { response } = await renderThenApprove();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${REDIRECT_URI}?code=the-code&state=probe&iss=https%3A%2F%2Fworker.example.com%2Fapi%2Fauth`,
    );
    expect(state.authHandler).toHaveBeenCalledOnce();
    const request = state.authHandler.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://worker.example.com/api/auth/oauth2/consent");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.clone().json()).toMatchObject({
      accept: true,
      scope: "mcp:read runs:dispatch",
    });
    // The redirect_uri reaching the provider comes from the signed cookie, never
    // from the form, which is what keeps the form from being an open redirect.
    expect((await request.json()).oauth_query).toContain(
      "client_id=eiWzIXwrrXzrZboIhhEFKalUtICrwHCe",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("grants offline_access to the provider so it issues a refresh token", async () => {
    const { response } = await renderThenApprove(
      "true",
      consentUrl({ scope: "mcp:read runs:dispatch offline_access" }),
    );

    expect(response.status).toBe(302);
    const request = state.authHandler.mock.calls[0]?.[0] as Request;
    const posted = (await request.json()) as { scope: string };
    // dist/index.mjs:509 only mints a refresh token when the granted scopes include
    // offline_access, so it has to survive all the way to this POST.
    expect(posted.scope.split(" ")).toContain("offline_access");
    expect(posted.scope.split(" ")).toEqual(
      expect.arrayContaining(["mcp:read", "runs:dispatch", "offline_access"]),
    );
  });

  it("carries a denial through instead of pretending it approved", async () => {
    const { response } = await renderThenApprove("false");

    expect(response.status).toBe(302);
    const request = state.authHandler.mock.calls[0]?.[0] as Request;
    await expect(request.json()).resolves.toMatchObject({ accept: false });
  });

  it("still refuses a cross-origin post, which the reordered body read must not weaken", async () => {
    const response = await handlerFor(consentPost)(
      new Request("https://worker.example.com/mcp-auth/consent", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ flow_id: "x", scope: "mcp:read", accept: "true" }).toString(),
      }),
    );

    expect(response.status).toBe(403);
    expect(state.authHandler).not.toHaveBeenCalled();
  });

  it("names the missing form field instead of blaming expiry", async () => {
    const response = await handlerFor(consentPost)(
      new Request("https://worker.example.com/mcp-auth/consent", {
        method: "POST",
        headers: {
          origin: "https://worker.example.com",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ scope: "mcp:read", accept: "true" }).toString(),
      }),
    );

    expect(response.status).toBe(400);
    // Three different failures used to answer "OAuth request expired", which made
    // the production 400 impossible to attribute from the outside or from the logs.
    await expect(response.text()).resolves.toContain("Missing consent form field");
  });

  it("names an unreadable cookie instead of blaming expiry", async () => {
    const rendered = await handlerFor(consentGet)(new Request(consentUrl()));
    const html = await rendered.text();
    const flowId = /name="flow_id" value="([^"]+)"/.exec(html)?.[1];

    const response = await handlerFor(consentPost)(
      new Request("https://worker.example.com/mcp-auth/consent", {
        method: "POST",
        headers: {
          origin: "https://worker.example.com",
          // No cookie at all: the browser dropped it, or it never arrived.
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          flow_id: String(flowId),
          scope: "mcp:read",
          accept: "true",
        }).toString(),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Consent flow cookie");
  });

  it("names a provider rejection instead of blaming expiry", async () => {
    state.authHandler.mockResolvedValue(
      Response.json({ error: "invalid_signature" }, { status: 400 }),
    );

    const { response } = await renderThenApprove();

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Authorization server rejected");
    expect(state.loggerWarn).toHaveBeenCalledWith(
      { code: "invalid_signature" },
      "mcp_consent_post_rejected_by_authorization_server",
    );
  });

  it("normalizes unknown provider errors without logging their details", async () => {
    const secret = "oauth-query-and-secret-details";
    state.authHandler.mockResolvedValue(Response.json({ error: secret }, { status: 400 }));

    const { response } = await renderThenApprove();

    expect(response.status).toBe(400);
    expect(state.loggerWarn).toHaveBeenCalledWith(
      { code: "unknown" },
      "mcp_consent_post_rejected_by_authorization_server",
    );
    expect(JSON.stringify(state.loggerWarn.mock.calls)).not.toContain(secret);
  });
});
