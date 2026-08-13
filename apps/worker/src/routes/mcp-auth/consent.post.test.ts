// The POST half of the consent screen, which had no cover at all: AIW-270 was
// fixed for GET, the page rendered, and then every POST answered
// 400 "OAuth request expired" on production. Three different failures share that
// one message, so this file drives the REAL handoff (GET sets the cookie and
// renders the flow id, POST sends both back) rather than hand-building a cookie.
import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  prelogin: vi.fn(),
  consent: vi.fn(),
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
    api: {
      getOAuthClientPublicPrelogin: state.prelogin,
      oauth2Consent: state.consent,
    },
  },
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
  state.consent.mockResolvedValue({
    url: `${REDIRECT_URI}?code=the-code&state=probe`,
  });
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function consentUrl(): string {
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
  });
  return `https://worker.example.com/mcp-auth/consent?${query.toString()}`;
}

/** Walks the browser's half: render the page, then post the form it rendered. */
async function renderThenApprove(accept = "true") {
  const rendered = await handlerFor(consentGet)(new Request(consentUrl()));
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
    expect(response.headers.get("location")).toBe(`${REDIRECT_URI}?code=the-code&state=probe`);
    expect(state.consent).toHaveBeenCalledOnce();
    // The redirect_uri reaching the provider comes from the signed cookie, never
    // from the form, which is what keeps the form from being an open redirect.
    expect(state.consent.mock.calls[0]?.[0]?.body?.oauth_query).toContain(
      "client_id=eiWzIXwrrXzrZboIhhEFKalUtICrwHCe",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("carries a denial through instead of pretending it approved", async () => {
    const { response } = await renderThenApprove("false");

    expect(response.status).toBe(302);
    expect(state.consent.mock.calls[0]?.[0]?.body?.accept).toBe(false);
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
    expect(state.consent).not.toHaveBeenCalled();
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
    state.consent.mockRejectedValue(new Error("invalid_signature"));

    const rendered = await handlerFor(consentGet)(new Request(consentUrl()));
    const html = await rendered.text();
    const setCookie = rendered.headers.get("set-cookie") ?? "";
    const flowId = /name="flow_id" value="([^"]+)"/.exec(html)?.[1];

    const response = await handlerFor(consentPost)(
      new Request("https://worker.example.com/mcp-auth/consent", {
        method: "POST",
        headers: {
          origin: "https://worker.example.com",
          cookie: setCookie.split(";")[0] ?? "",
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
    await expect(response.text()).resolves.toContain("Authorization server rejected");
  });
});
