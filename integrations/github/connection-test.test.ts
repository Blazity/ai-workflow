import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { runtime } from "./worker";

/**
 * What an admin reads after pressing Test on a GitHub connection, and what the
 * card does next.
 *
 * `{ ok: false }` makes the card Failing and stops every run that needs
 * GitHub; a throw is filed as GitHub being unreachable and leaves the card as
 * it was. So a key GitHub refuses has to come back as a refusal, and GitHub
 * being down, rate limited or unreachable has to come back as a throw. The
 * test used to catch everything and return a refusal.
 *
 * The real Octokit and the real App auth run here, JWT signing and token
 * minting included; only `ctx.http.fetch` is replaced, which is the provider
 * boundary and the only way the test reaches GitHub.
 */
const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

type Answer = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** GitHub answering every call a passing test makes. */
const healthy: Answer = (url) => {
  if (url.pathname === "/app") return json(200, { slug: "ai-workflow", name: "AI Workflow" });
  if (url.pathname === "/app/installations/22/access_tokens") {
    return json(201, { token: "ghs_installation", expires_at: "2099-01-01T00:00:00Z" });
  }
  if (url.pathname === "/installation/repositories") {
    return json(200, { total_count: 3, repositories: [] });
  }
  return json(404, { message: "Not Found" });
};

function context(answer: Answer) {
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) =>
    answer(new URL(String(input)), init),
  );
  return {
    ctx: {
      connection: {
        appId: 11,
        privateKey: PRIVATE_KEY,
        installationId: 22,
        webhookSecret: "webhook-secret",
      },
      http: { fetch },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      signal: new AbortController().signal,
    } as never,
    fetch,
  };
}

describe("the GitHub connection test", () => {
  it("passes through the context's HTTP, installation token included", async () => {
    const { ctx, fetch } = context(healthy);

    await expect(runtime.testConnection(ctx)).resolves.toEqual({
      ok: true,
      message: "Connected as ai-workflow; installation 22 can see 3 repositories.",
    });
    // Going around `ctx.http` is what let a hung GitHub outlive the test's own
    // deadline: nothing else is bound to it.
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/app",
      "/app/installations/22/access_tokens",
      "/installation/repositories",
    ]);
  });

  it("refuses a key GitHub does not accept", async () => {
    const { ctx } = context((url) =>
      url.pathname === "/app"
        ? json(401, { message: "A JSON web token could not be decoded" })
        : healthy(url, undefined),
    );

    await expect(runtime.testConnection(ctx)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("JSON web token"),
    });
  });

  it("refuses an installation that no longer exists", async () => {
    const { ctx } = context((url) =>
      url.pathname === "/app/installations/22/access_tokens"
        ? json(404, { message: "Not Found" })
        : healthy(url, undefined),
    );

    await expect(runtime.testConnection(ctx)).resolves.toMatchObject({ ok: false });
  });

  it("throws, rather than refusing, when GitHub is down", async () => {
    const { ctx } = context((url) =>
      url.pathname === "/app" ? json(503, { message: "Service Unavailable" }) : healthy(url, undefined),
    );

    await expect(runtime.testConnection(ctx)).rejects.toMatchObject({ status: 503 });
  });

  it("throws, rather than refusing, when the rate limit is spent", async () => {
    // GitHub answers a spent primary rate limit with 403 and a remaining of 0.
    const { ctx } = context((url) =>
      url.pathname === "/installation/repositories"
        ? json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })
        : healthy(url, undefined),
    );

    await expect(runtime.testConnection(ctx)).rejects.toMatchObject({ status: 403 });
  });

  it("throws, rather than refusing, when GitHub cannot be reached", async () => {
    const { ctx } = context(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), {
          code: "ENOTFOUND",
        }),
      });
    });

    await expect(runtime.testConnection(ctx)).rejects.toThrow(/ENOTFOUND/u);
  });
});
