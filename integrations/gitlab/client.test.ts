import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPullRequestUnreadableError, readProviderFailure } from "@integrations/sdk";

import { runtime } from "./worker";

/**
 * One client for everything this integration asks GitLab, and it is the
 * context's: Gitbeaker's resources and the adapter's own REST calls both send
 * through `ctx.http.fetch`, so every request has core's attempt deadline, its
 * retry policy, the context's lifetime and its redaction. Until this, the
 * adapter sent on the global `fetch` with none of them, and Gitbeaker retried
 * a 429 ten times on its own.
 *
 * The real Gitbeaker runs here; only the context's fetch answers, with the
 * statuses and bodies GitLab's REST API documents, and the global `fetch`
 * refuses, so a request that goes around the context fails the test.
 */
const HEAD = "4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Answer = (url: URL, init: RequestInit | undefined) => Response;

const mergeRequest = {
  iid: 7,
  sha: HEAD,
  diff_refs: { head_sha: HEAD },
  source_branch: "fix",
  target_branch: "main",
  state: "opened",
  head_pipeline: null,
};

const gitlab: Answer = (url) => {
  const path = decodeURIComponent(url.pathname);
  if (path === "/api/v4/projects/acme/api/merge_requests/7") return json(200, mergeRequest);
  if (path === "/api/v4/projects/acme/api/repository/branches/gone") {
    return json(404, { message: "404 Branch Not Found" });
  }
  if (path === "/api/v4/projects") {
    return json(200, [{ path_with_namespace: "acme/api", name: "api", web_url: "https://gitlab.example.com/acme/api" }]);
  }
  return json(404, { message: "404 Not Found" });
};

function connected(answer: Answer = gitlab) {
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => answer(new URL(String(input)), init));
  const ctx = {
    connection: { token: "glpat-test", host: "https://gitlab.example.com", webhookSecret: "s" },
    http: { fetch },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
  };
  const vcs = runtime.capabilities.vcs(ctx as never, { repoPath: "acme/api", baseBranch: "main" });
  const requests = () =>
    fetch.mock.calls.map(([url, init]) => ({
      request: `${init?.method ?? "GET"} ${decodeURIComponent(new URL(String(url)).pathname)}`,
      token: new Headers(init?.headers).get("private-token"),
    }));
  return { vcs, requests };
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("A request went around ctx.http.");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every GitLab call goes through the context's HTTP", () => {
  it("reads a merge request's head through Gitbeaker, with the token", async () => {
    const { vcs, requests } = connected();

    await expect(vcs.getPRHead(7)).resolves.toMatchObject({ headSha: HEAD, baseRef: "main", state: "open" });
    expect(requests()).toEqual([
      { request: "GET /api/v4/projects/acme/api/merge_requests/7", token: "glpat-test" },
    ]);
  });

  it("lists the projects the token is a member of", async () => {
    const { vcs, requests } = connected();

    await expect(vcs.listRepositories!()).resolves.toEqual([
      expect.objectContaining({ provider: "gitlab", repoPath: "acme/api" }),
    ]);
    expect(requests()).toEqual([{ request: "GET /api/v4/projects", token: "glpat-test" }]);
  });

  it("reads a branch GitLab says is not there as absent", async () => {
    const { vcs } = connected();

    await expect(vcs.getBranchShaIfExists("gone")).resolves.toBeNull();
  });

  // GitLab's REST pagination docs: a list answers one page and a `Link`
  // header whose `rel="next"` names the following one; Gitbeaker follows it.
  it("follows a list to its last page", async () => {
    const note = (id: number) => ({
      id,
      body: `note ${id}`,
      system: false,
      type: null,
      author: { username: "reviewer" },
    });
    const notes = "https://gitlab.example.com/api/v4/projects/acme%2Fapi/merge_requests/7/notes";
    const { vcs, requests } = connected((url) => {
      const path = decodeURIComponent(url.pathname);
      if (path.endsWith("/merge_requests/7/discussions")) return json(200, []);
      if (path.endsWith("/merge_requests/7/notes")) {
        return url.searchParams.get("page") === "2"
          ? json(200, [note(2)])
          : json(200, [note(1)], { link: `<${notes}?page=2&per_page=1>; rel="next"` });
      }
      return gitlab(url, undefined);
    });

    await expect(vcs.getPRComments(7)).resolves.toEqual([
      expect.objectContaining({ body: "note 1" }),
      expect.objectContaining({ body: "note 2" }),
    ]);
    expect(requests().filter(({ request }) => request.endsWith("/notes"))).toHaveLength(2);
  });
});

describe("what GitLab answered survives the client", () => {
  // GitLab's REST authentication docs: 401 for a token it does not accept.
  it("keeps a refused token retryable, with GitLab's status on it", async () => {
    const { vcs } = connected((url) =>
      url.pathname.endsWith("/merge_requests/7") ? json(401, { message: "401 Unauthorized" }) : gitlab(url, undefined),
    );

    const failure = await vcs.getPRHead(7).catch((error: unknown) => error);

    expect(isPullRequestUnreadableError(failure)).toBe(false);
    expect(readProviderFailure(failure)).toMatchObject({ kind: "refused", status: 401 });
  });

  it("closes a merge request this token can never read", async () => {
    const { vcs } = connected((url) =>
      url.pathname.endsWith("/merge_requests/7") ? json(404, { message: "404 Not found" }) : gitlab(url, undefined),
    );

    await expect(vcs.getPRHead(7)).rejects.toSatisfy(isPullRequestUnreadableError);
  });

  it("reads a scope GitLab refuses as the token's, not the merge request's", async () => {
    const { vcs } = connected((url) =>
      url.pathname.endsWith("/merge_requests/7")
        ? json(403, {
            error: "insufficient_scope",
            error_description: "The request requires higher privileges than provided by the access token.",
            scope: "api read_api",
          })
        : gitlab(url, undefined),
    );

    const failure = await vcs.getPRHead(7).catch((error: unknown) => error);

    expect(isPullRequestUnreadableError(failure)).toBe(false);
    expect(readProviderFailure(failure)).toMatchObject({ kind: "refused", status: 403 });
  });
});

/**
 * The head alone is the same read under the same rule: a merge request this
 * token can never read is closed for good, a token GitLab refused is thrown as
 * it came. It used to answer both with a FatalError, so a caller could not tell
 * a merge request that is gone from a connection that needs repairing.
 */
describe("the head sha is read like the head", () => {
  const refusing = (status: number, body: unknown) =>
    connected((url) =>
      url.pathname.endsWith("/merge_requests/7") ? json(status, body) : gitlab(url, undefined),
    ).vcs;

  it("reads the sha the head carries", async () => {
    const { vcs } = connected();

    await expect(vcs.getPRHeadSha(7)).resolves.toBe((await vcs.getPRHead(7)).headSha);
  });

  it("closes a merge request this token can never read", async () => {
    const failure = await refusing(404, { message: "404 Not found" })
      .getPRHeadSha(7)
      .catch((error: unknown) => error);

    expect(isPullRequestUnreadableError(failure)).toBe(true);
  });

  it("keeps a refused token retryable, with GitLab's status on it", async () => {
    const failure = await refusing(401, { message: "401 Unauthorized" })
      .getPRHeadSha(7)
      .catch((error: unknown) => error);

    expect((failure as Error).name).not.toBe("FatalError");
    expect(isPullRequestUnreadableError(failure)).toBe(false);
    expect(readProviderFailure(failure)).toMatchObject({ kind: "refused", status: 401 });
  });
});
