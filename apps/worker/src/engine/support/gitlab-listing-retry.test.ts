import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GitLab's repository listing through core's retry ladder, both real.
 *
 * The ladder retries only what GitLab can recover from without us changing
 * anything, and it tells the two apart by what the thrown error carries. A
 * GitLab failure that carried nothing read as permanent, so a 5xx blip failed
 * a catalog import outright, and a timeout surfaced as the runtime's bare
 * "The operation was aborted due to timeout". Only `fetch` is replaced.
 */
// The runtime module also resolves adapters from this deployment's settings,
// which is not what is under test: its environment is empty here.
vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));

const { GitLabAdapter } = await import("../../../../../integrations/gitlab/vcs.js");
const { listWithRetry } = await import("./vcs-runtime.js");

const fetchMock = vi.fn();

function adapter() {
  return new GitLabAdapter(
    { token: "glpat-test", projectId: "platform/api", baseBranch: "main" },
    {} as never,
  );
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
  // The ladder's backoff is real; keep the suite fast without changing it.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listing GitLab projects through the retry ladder", () => {
  it("waits out a GitLab 5xx and keeps the recovered listing", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("upstream down", { status: 503, statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(projects());
    const gitlab = adapter();

    const listed = await listWithRetry(() => gitlab.listRepositories());

    expect(listed.map((repository) => repository.repoPath)).toEqual(["platform/api"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never replays a refused credential", async () => {
    fetchMock.mockResolvedValue(new Response("no", { status: 401, statusText: "Unauthorized" }));
    const gitlab = adapter();

    await expect(listWithRetry(() => gitlab.listRepositories())).rejects.toThrow(
      "GitLab projects list failed: 401 Unauthorized",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names GitLab and the budget when the listing times out", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const gitlab = adapter();

    await expect(listWithRetry(() => gitlab.listRepositories())).rejects.toThrow(
      "GitLab projects list timed out after 18000ms",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
