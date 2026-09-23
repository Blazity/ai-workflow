import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runtime } from "./worker";

/**
 * One client for everything this integration asks GitHub, and it is the
 * context's. Every request an adapter makes then has core's attempt deadline,
 * its retry policy, the context's lifetime and its redaction; a request that
 * went around it had none of them, and a GitHub that accepted a connection and
 * never answered held a run's step until the platform killed it.
 *
 * The real Octokit and the real App auth run here, JWT signing and token
 * minting included; only `ctx.http.fetch` is replaced, and the global `fetch`
 * refuses, so a request that goes around the context fails the test.
 */
const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GitHub's REST API, for the calls these cases make. */
function github(url: URL): Response {
  if (url.pathname === "/app/installations/22/access_tokens") {
    return json(201, { token: "ghs_installation", expires_at: "2099-01-01T00:00:00Z" });
  }
  if (url.pathname === "/app") return json(200, { slug: "ai-workflow", name: "AI Workflow" });
  if (decodeURIComponent(url.pathname) === "/users/ai-workflow[bot]") return json(200, { id: 7 });
  if (url.pathname === "/repos/acme/api/pulls/7") {
    return json(200, { head: { sha: "4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c", ref: "fix" } });
  }
  if (url.pathname === "/repos/acme/api") return json(200, { default_branch: "trunk" });
  return json(404, { message: "Not Found" });
}

function connected() {
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    void init;
    return github(new URL(String(input)));
  });
  const ctx = {
    connection: {
      appId: 11,
      privateKey: PRIVATE_KEY,
      installationId: 22,
      webhookSecret: "webhook-secret",
    },
    http: { fetch },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
  };
  const vcs = runtime.capabilities.vcs(ctx as never, { repoPath: "acme/api", baseBranch: "main" });
  const paths = () =>
    fetch.mock.calls.map(
      ([url, init]) => `${init?.method ?? "GET"} ${decodeURIComponent(new URL(String(url)).pathname)}`,
    );
  return { vcs, paths };
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("A request went around ctx.http.");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every GitHub call goes through the context's HTTP", () => {
  it("reads a pull request, the installation token it needs included", async () => {
    const { vcs, paths } = connected();

    await expect(vcs.getPRHeadSha(7)).resolves.toBe("4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c");
    expect(paths()).toEqual([
      "POST /app/installations/22/access_tokens",
      "GET /repos/acme/api/pulls/7",
    ]);
  });

  it("mints a sandbox's credentials and reads the App's identity", async () => {
    const { vcs, paths } = connected();

    await expect(vcs.sandboxCredentials!()).resolves.toMatchObject({
      token: "ghs_installation",
      commitAuthor: "ai-workflow[bot]",
      commitEmail: "7+ai-workflow[bot]@users.noreply.github.com",
    });
    expect(paths()).toEqual(
      expect.arrayContaining([
        "GET /app",
        "GET /users/ai-workflow[bot]",
        "POST /app/installations/22/access_tokens",
      ]),
    );
  });

  it("reads a skill source's repository", async () => {
    const { vcs, paths } = connected();

    await expect(
      vcs.skillSource!().getDefaultBranch({ owner: "acme", repository: "api" }),
    ).resolves.toBe("trunk");
    expect(paths()).toContain("GET /repos/acme/api");
  });
});
