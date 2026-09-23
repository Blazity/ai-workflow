import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationManifest } from "@integrations/registry";
import { integrationRuntime } from "@integrations/registry/worker";

/**
 * GitLab's requests through the context core hands the integration, both
 * real: the retry policy every integration gets, applied to what the GitLab
 * adapter actually sends (Gitbeaker's calls included).
 *
 * The listing:
 * The listing is retried by the context's HTTP policy, the one every
 * integration gets: a page GitLab failed on its own side or never answered is
 * asked again, a refusal never is. A GitLab failure that carried nothing once
 * read as permanent, so a 5xx blip failed a catalog import outright, and a
 * timeout surfaced as the runtime's bare "The operation was aborted due to
 * timeout". Only the global `fetch` is replaced.
 */
const { buildIntegrationContext } = await import("../../services/integrations/context.js");

const fetchMock = vi.fn();

interface GitLabUnderTest {
  listRepositories(): Promise<Array<{ repoPath: string }>>;
  getPRHead(prId: number): Promise<{ headSha: string }>;
  postPRComment(prId: number, body: string): Promise<{ url: string | null }>;
}

function gitlab(): GitLabUnderTest {
  const manifest = integrationManifest("gitlab")!;
  const ctx = buildIntegrationContext({
    manifest,
    values: { token: "glpat-test", host: "https://gitlab.com" },
    secrets: ["glpat-test"],
    lifetime: new AbortController().signal,
  });
  return (integrationRuntime("gitlab")!.capabilities.vcs as (
    context: typeof ctx,
    repository: { repoPath: string; baseBranch: string },
  ) => GitLabUnderTest)(ctx, {
    repoPath: "platform/api",
    baseBranch: "main",
  });
}

function projects() {
  return new Response(
    JSON.stringify([
      {
        path_with_namespace: "platform/api",
        name: "api",
        namespace: { full_path: "platform" },
        default_branch: "main",
        web_url: "https://gitlab.com/platform/api",
        visibility: "private",
      },
    ]),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listing GitLab projects through the context's HTTP", () => {
  it("waits out a GitLab 5xx and keeps the recovered listing", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("upstream down", { status: 503, statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(projects());

    const listed = await gitlab().listRepositories();

    expect(listed.map((repository) => repository.repoPath)).toEqual(["platform/api"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never replays a refused credential", async () => {
    fetchMock.mockResolvedValue(new Response("no", { status: 401, statusText: "Unauthorized" }));

    await expect(gitlab().listRepositories()).rejects.toThrow(
      "GitLab projects list failed: 401 Unauthorized",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names GitLab and the budget when the listing times out", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    await expect(gitlab().listRepositories()).rejects.toThrow(
      "GitLab projects list timed out after 18000ms",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("GitLab's reads and writes through the context's HTTP", () => {
  it("never sends a note again after GitLab failed on its own side", async () => {
    // The note may have been posted before the 502; a second one would be a
    // duplicate on somebody's merge request.
    fetchMock.mockResolvedValue(new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }));

    await expect(gitlab().postPRComment(7, "hello")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("asks for a merge request again once GitLab's rate limit says it may", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sha: "4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c",
            target_branch: "main",
            state: "opened",
            head_pipeline: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await expect(gitlab().getPRHead(7)).resolves.toMatchObject({
      headSha: "4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
