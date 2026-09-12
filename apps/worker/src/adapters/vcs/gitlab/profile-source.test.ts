import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryMissingAtProviderError } from "../repository-profile-source.js";
import { createGitLabProfileSource } from "./profile-source.js";

/**
 * Recorded GitLab answers, in this file's own convention: a stubbed global
 * fetch handing back canned responses per path, exactly as `gitlab.test.ts`
 * records the rest of the GitLab surface.
 */
const mockFetch = vi.fn();

const CONFIG = { token: "glpat-test", host: "https://gitlab.example.com" };
const PROJECT = "acme%2Fapi";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function notFound(): Response {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    json: vi.fn(),
    text: vi.fn(),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the GitLab repository profile source", () => {
  it("reads the metadata, the README, the manifests, the CI file and the languages", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(`/projects/${PROJECT}`)) {
        return jsonResponse({ default_branch: "main", description: "The API" });
      }
      if (url.endsWith(`/projects/${PROJECT}/languages`)) {
        return jsonResponse({ TypeScript: 92.1, Shell: 7.9 });
      }
      if (url.includes("/repository/tree?")) {
        return jsonResponse([
          { name: "README.md", type: "blob" },
          { name: "package.json", type: "blob" },
          { name: "pnpm-lock.yaml", type: "blob" },
          { name: ".gitlab-ci.yml", type: "blob" },
          { name: "src", type: "tree" },
        ]);
      }
      if (url.includes("/files/README.md/raw")) return textResponse("# acme api");
      if (url.includes("/files/package.json/raw")) return textResponse('{"name":"api"}');
      if (url.includes("/files/.gitlab-ci.yml/raw")) return textResponse("test:\n  script: []\n");
      return notFound();
    });

    const bundle = await createGitLabProfileSource(CONFIG, "acme/api").loadProfile();

    expect(bundle).toEqual({
      provider: "gitlab",
      repoPath: "acme/api",
      defaultBranch: "main",
      description: "The API",
      readme: "# acme api",
      manifests: [{ path: "package.json", content: '{"name":"api"}' }],
      lockfiles: ["pnpm-lock.yaml"],
      ciDefinitions: [{ path: ".gitlab-ci.yml", content: "test:\n  script: []\n" }],
      languages: ["TypeScript", "Shell"],
      truncated: [],
    });
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { "PRIVATE-TOKEN": "glpat-test" },
    });
  });

  it("still yields the provider metadata for a repository with no README and no manifests", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(`/projects/${PROJECT}`)) {
        return jsonResponse({ default_branch: "main", description: "" });
      }
      if (url.endsWith(`/projects/${PROJECT}/languages`)) return jsonResponse({});
      if (url.includes("/repository/tree?")) {
        return jsonResponse([{ name: "src", type: "tree" }]);
      }
      return notFound();
    });

    const bundle = await createGitLabProfileSource(CONFIG, "acme/api").loadProfile();

    expect(bundle).toEqual({
      provider: "gitlab",
      repoPath: "acme/api",
      defaultBranch: "main",
      description: "",
      readme: "",
      manifests: [],
      lockfiles: [],
      ciDefinitions: [],
      languages: [],
      truncated: [],
    });
  });

  it("reads nothing from the tree for a project with no default branch", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(`/projects/${PROJECT}`)) return jsonResponse({ description: "Empty" });
      if (url.endsWith(`/projects/${PROJECT}/languages`)) return jsonResponse({});
      throw new Error(`unexpected request: ${url}`);
    });

    const bundle = await createGitLabProfileSource(CONFIG, "acme/api").loadProfile();

    expect(bundle.defaultBranch).toBe("");
    expect(bundle.readme).toBe("");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("reports a project the provider no longer has, instead of an empty bundle", async () => {
    mockFetch.mockResolvedValue(notFound());

    await expect(
      createGitLabProfileSource(CONFIG, "acme/deleted").loadProfile(),
    ).rejects.toBeInstanceOf(RepositoryMissingAtProviderError);
  });

  it("says out loud that the root listing stopped at a page boundary", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      name: `file-${index}.txt`,
      type: "blob",
    }));
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(`/projects/${PROJECT}`)) {
        return jsonResponse({ default_branch: "main", description: "" });
      }
      if (url.endsWith(`/projects/${PROJECT}/languages`)) return jsonResponse({});
      if (url.includes("/repository/tree?")) return jsonResponse(entries);
      return notFound();
    });

    const bundle = await createGitLabProfileSource(CONFIG, "acme/api").loadProfile();

    // Recorded with no original length, because a page boundary knows what it
    // kept and cannot know what it missed.
    expect(bundle.truncated).toEqual([
      { what: "root tree, first 100 entries", originalLength: null, keptLength: 100 },
    ]);
  });

  it("bounds the whole read with one deadline, not one per request", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(`/projects/${PROJECT}`)) {
        return jsonResponse({ default_branch: "main", description: "" });
      }
      if (url.endsWith(`/projects/${PROJECT}/languages`)) return jsonResponse({});
      if (url.includes("/repository/tree?")) {
        return jsonResponse([{ name: "package.json", type: "blob" }]);
      }
      if (url.includes("/files/package.json/raw")) return textResponse("{}");
      return notFound();
    });

    await createGitLabProfileSource(CONFIG, "acme/api").loadProfile();

    const signals = mockFetch.mock.calls.map(
      (call) => (call[1] as { signal?: AbortSignal }).signal,
    );
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    // A dozen sequential requests each under their own bound would add up to
    // minutes; the caller's 90 second model call assumes this half is capped in
    // total, so every request shares the one signal.
    expect(new Set(signals).size).toBe(1);
  });

  it("gives up the whole read when the shared deadline has already fired", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    mockFetch.mockImplementation(async (_url: string, init: { signal?: AbortSignal }) => {
      init.signal?.throwIfAborted();
      return jsonResponse({});
    });

    await expect(
      createGitLabProfileSource(CONFIG, "acme/api").loadProfile(),
    ).rejects.toThrow();
    vi.mocked(AbortSignal.timeout).mockRestore();
  });

  it("fails loudly on a refusal that is not a missing path", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: vi.fn(),
      text: vi.fn(),
    } as unknown as Response);

    await expect(
      createGitLabProfileSource(CONFIG, "acme/api").loadProfile(),
    ).rejects.toThrow(/401 Unauthorized/u);
  });
});
