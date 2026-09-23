import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationManifest } from "@integrations/registry";
import { integrationRuntime } from "@integrations/registry/worker";

/**
 * GitLab's repository listing through the context core hands the integration,
 * both real.
 *
 * The listing is retried by the context's HTTP policy, the one every
 * integration gets: a page GitLab failed on its own side or never answered is
 * asked again, a refusal never is. A GitLab failure that carried nothing once
 * read as permanent, so a 5xx blip failed a catalog import outright, and a
 * timeout surfaced as the runtime's bare "The operation was aborted due to
 * timeout". Only the global `fetch` is replaced.
 */
const { buildIntegrationContext } = await import("../../services/integrations/context.js");

const fetchMock = vi.fn();

function gitlab() {
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
  ) => { listRepositories(): Promise<Array<{ repoPath: string }>> })(ctx, {
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
