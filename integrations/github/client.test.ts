import { generateKeyPairSync } from "node:crypto";
import { isPullRequestUnreadableError } from "@integrations/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildOctokit } from "./auth";
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

    await expect(vcs.getPRConflictStatus(7)).resolves.toBe(false);
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

describe("a pull request GitHub says is not there", () => {
  // GitHub answers 404 for a pull request that does not exist, and for one in
  // a repository the installation cannot see.
  it("is closed for good through the real client", async () => {
    const { vcs } = connected();

    await expect(vcs.getPRHead(8)).rejects.toSatisfy(isPullRequestUnreadableError);
  });
});

/**
 * GraphQL is always a POST, so the context's rule for a write (sent once)
 * applied to every review thread read as well, and a read GitHub failed on its
 * own side was not asked again. A document that is not a mutation is a read,
 * and the client says so to the context; a mutation is still sent once.
 */
describe("GraphQL through the context", () => {
  function graphqlClient() {
    const asked: Array<{ query: string; retries: unknown }> = [];
    const fetch = vi.fn(async (input: unknown, init?: RequestInit & { retries?: number }) => {
      const url = new URL(String(input));
      if (url.pathname === "/graphql") {
        asked.push({
          query: (JSON.parse(String(init?.body)) as { query: string }).query,
          retries: init?.retries,
        });
        return json(200, { data: { viewer: { login: "ai-workflow[bot]" } } });
      }
      return github(url);
    });
    const octokit = buildOctokit(
      { appId: 11, privateKey: PRIVATE_KEY, installationId: 22 },
      fetch as never,
    );
    return { octokit, asked };
  }

  it("asks for a query to be retried like any other read", async () => {
    const { octokit, asked } = graphqlClient();

    await octokit.graphql("query { viewer { login } }");

    expect(asked).toEqual([{ query: "query { viewer { login } }", retries: 2 }]);
  });

  it("leaves a mutation to the rule for writes", async () => {
    const { octokit, asked } = graphqlClient();

    await octokit.graphql('mutation { resolveReviewThread(input: { threadId: "T" }) { clientMutationId } }');

    expect(asked).toEqual([expect.objectContaining({ retries: undefined })]);
  });
});
