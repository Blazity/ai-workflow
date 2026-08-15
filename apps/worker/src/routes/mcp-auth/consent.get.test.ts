// Regression cover for the consent screen, which had none: every MCP client
// (Claude Code, Claude Desktop, an Arthur agent) was refused here with
// "Invalid OAuth request" while 394 MCP tests stayed green, because the tests
// all start from an actor and never walk the browser half of the flow.
import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  prelogin: vi.fn(),
  env: {
    BETTER_AUTH_SECRET: "test-secret",
  },
}));

vi.mock("../../../env.js", () => ({
  env: state.env,
}));

vi.mock("../../auth-instance.js", () => ({
  auth: {
    api: {
      getOAuthClientPublicPrelogin: state.prelogin,
    },
  },
}));

const consentRoute = (await import("./consent.get.js")).default;

const CLIENT_ID = "eiWzIXwrrXzrZboIhhEFKalUtICrwHCe";
const REDIRECT_URI = "http://127.0.0.1:43110/callback";

beforeEach(() => {
  vi.clearAllMocks();
  // The exact shape production returns. /oauth2/public-client-prelogin answers a
  // caller who is not signed in yet, so it withholds the registered redirect
  // list: verified against the deployment with the signed query taken from a
  // real /oauth2/authorize redirect, which answered
  // {"client_id":"eiWzIX…","client_name":"aiw-dogfood-pkce","redirect_uris":[]}.
  state.prelogin.mockResolvedValue({
    client_id: CLIENT_ID,
    client_name: "aiw-dogfood-pkce",
    redirect_uris: [],
  });
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
    scope: "mcp:read",
    state: "probe",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    exp: "1786597132",
    ba_iat: "1786596532923",
    sig: "0e6g9sZI2vvfQEnndJjoGGfdPi2kfBu9W21XvBmGbe4=",
    ...overrides,
  });
  return `http://worker.example.com/mcp-auth/consent?${query.toString()}`;
}

describe("MCP consent screen", () => {
  it("renders for a public client, whose registered redirects prelogin never returns", async () => {
    const response = await handlerFor(consentRoute)(new Request(consentUrl()));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Authorize");
    expect(body).toContain("aiw-dogfood-pkce");
    // The host the human decides on has to be the one from the signed query.
    expect(body).toContain("127.0.0.1");
    expect(body).toContain('name="accept" value="true"');
    expect(response.headers.get("set-cookie")).toContain("Path=/");
  });

  it("still refuses a scope the deployment does not advertise", async () => {
    const response = await handlerFor(consentRoute)(
      new Request(consentUrl({ scope: "mcp:read admin:all" })),
    );

    expect(response.status).toBe(400);
  });

  it("renders offline_access as a refresh-token scope when the client requests it", async () => {
    const response = await handlerFor(consentRoute)(
      new Request(consentUrl({ scope: "mcp:read offline_access" })),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("offline_access");
    expect(body).toContain("Stay signed in");
    // The hidden field the browser posts back has to carry it, or the provider never
    // issues a refresh token.
    expect(body).toContain('name="scope" value="mcp:read offline_access"');
  });

  it("leaves a request without offline_access exactly as it was", async () => {
    const response = await handlerFor(consentRoute)(
      new Request(
        consentUrl({
          scope: "mcp:read runs:dispatch prompts:write workflows:write tickets:write",
        }),
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("offline_access");
    expect(body).not.toContain("Stay signed in");
  });

  it("still refuses an unregistered or edited redirect, whose signature prelogin rejects", async () => {
    // This is the negative case for the check the route no longer performs.
    // Two independent guards keep it covered, both verified against the
    // deployment rather than assumed. First, /oauth2/authorize refuses a
    // redirect_uri outside the client's registered set before it ever redirects
    // here (@better-auth/oauth-provider@1.6.20, dist/index.mjs:3864-3872), and
    // answered 400 for http://evil.example/cb on a client registered only for
    // loopback. Second, redirect_uri is inside the HMAC over the ba_param list:
    // swapping it in a genuine signed query made prelogin answer
    // {"error":"invalid_signature"}, which this route turns into the 400 below.
    // A third guard sits past consent: the token exchange rejects a redirect_uri
    // that differs from the one stored with the code (dist/index.mjs:581-582).
    state.prelogin.mockRejectedValue(new Error("invalid_signature"));

    const response = await handlerFor(consentRoute)(new Request(consentUrl()));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("OAuth request expired");
  });

  it("still refuses a query missing the client or the redirect", async () => {
    const withoutClient = new URLSearchParams(new URL(consentUrl()).search);
    withoutClient.delete("client_id");

    const response = await handlerFor(consentRoute)(
      new Request(`http://worker.example.com/mcp-auth/consent?${withoutClient.toString()}`),
    );

    expect(response.status).toBe(400);
    expect(state.prelogin).not.toHaveBeenCalled();
  });
});
