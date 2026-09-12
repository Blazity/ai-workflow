import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Recorded GitHub answers, in this file's own convention: canned responses per
 * endpoint through the Octokit the adapter builds, exactly as `github.test.ts`
 * records the rest of the GitHub surface. There are no fixtures on disk here
 * and adding a second mechanism for this one source would be the drift.
 */
const mockOctokit = {
  repos: {
    get: vi.fn(),
    getReadme: vi.fn(),
    listLanguages: vi.fn(),
    getContent: vi.fn(),
  },
};

vi.mock("../github-auth.js", () => ({ buildOctokit: vi.fn(() => mockOctokit) }));

const { createGitHubProfileSource } = await import("./profile-source.js");
const { RepositoryMissingAtProviderError } = await import(
  "../repository-profile-source.js"
);

const AUTH = { appId: 1, privateKeyBase64: "cGVt", installationId: 2 };

function content(text: string) {
  return { data: { content: Buffer.from(text, "utf8").toString("base64"), encoding: "base64" } };
}

function absent(): Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the GitHub repository profile source", () => {
  it("reads the metadata, the README, the manifests, the CI files and the languages", async () => {
    mockOctokit.repos.get.mockResolvedValue({
      data: { default_branch: "main", description: "The API" },
    });
    mockOctokit.repos.getReadme.mockResolvedValue(content("# acme api\n\nRun pnpm test."));
    mockOctokit.repos.listLanguages.mockResolvedValue({
      data: { TypeScript: 900, Shell: 10 },
    });
    mockOctokit.repos.getContent.mockImplementation(
      async ({ path }: { path: string }) => {
        if (path === "") {
          return {
            data: [
              { name: "README.md", type: "file" },
              { name: "package.json", type: "file" },
              { name: "pnpm-lock.yaml", type: "file" },
              { name: "src", type: "dir" },
            ],
          };
        }
        if (path === "package.json") return content('{"name":"api"}');
        if (path === ".github/workflows") {
          return {
            data: [
              { name: "ci.yml", path: ".github/workflows/ci.yml", type: "file" },
              { name: "notes.txt", path: ".github/workflows/notes.txt", type: "file" },
            ],
          };
        }
        if (path === ".github/workflows/ci.yml") return content("jobs:\n  test:\n");
        throw absent();
      },
    );

    const bundle = await createGitHubProfileSource(AUTH, "acme/api").loadProfile();

    expect(bundle).toEqual({
      provider: "github",
      repoPath: "acme/api",
      defaultBranch: "main",
      description: "The API",
      readme: "# acme api\n\nRun pnpm test.",
      manifests: [{ path: "package.json", content: '{"name":"api"}' }],
      lockfiles: ["pnpm-lock.yaml"],
      ciDefinitions: [{ path: ".github/workflows/ci.yml", content: "jobs:\n  test:\n" }],
      languages: ["TypeScript", "Shell"],
      truncated: [],
    });
  });

  it("still yields the provider metadata for a repository with no README and no manifests", async () => {
    mockOctokit.repos.get.mockResolvedValue({
      data: { default_branch: "trunk", description: "Nothing but code" },
    });
    mockOctokit.repos.getReadme.mockRejectedValue(absent());
    mockOctokit.repos.listLanguages.mockResolvedValue({ data: {} });
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "") return { data: [{ name: "src", type: "dir" }] };
      throw absent();
    });

    const bundle = await createGitHubProfileSource(AUTH, "acme/bare").loadProfile();

    expect(bundle).toEqual({
      provider: "github",
      repoPath: "acme/bare",
      defaultBranch: "trunk",
      description: "Nothing but code",
      readme: "",
      manifests: [],
      lockfiles: [],
      ciDefinitions: [],
      languages: [],
      truncated: [],
    });
  });

  it("refuses a path that is not owner/repo rather than guessing at one", () => {
    expect(() => createGitHubProfileSource(AUTH, "group/sub/project")).toThrow(
      /expected exactly "owner\/repo"/u,
    );
  });

  it("reports a repository the provider no longer has, instead of an empty bundle", async () => {
    mockOctokit.repos.get.mockRejectedValue(absent());
    mockOctokit.repos.getReadme.mockRejectedValue(absent());
    mockOctokit.repos.listLanguages.mockResolvedValue({ data: {} });
    mockOctokit.repos.getContent.mockResolvedValue({ data: [] });

    await expect(
      createGitHubProfileSource(AUTH, "acme/deleted").loadProfile(),
    ).rejects.toBeInstanceOf(RepositoryMissingAtProviderError);
  });

  it("bounds the whole read with one deadline, not one per request", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    mockOctokit.repos.get.mockImplementation(async (input: { request?: { signal?: AbortSignal } }) => {
      signals.push(input.request?.signal);
      return { data: { default_branch: "main", description: "" } };
    });
    mockOctokit.repos.getReadme.mockImplementation(
      async (input: { request?: { signal?: AbortSignal } }) => {
        signals.push(input.request?.signal);
        throw absent();
      },
    );
    mockOctokit.repos.listLanguages.mockImplementation(
      async (input: { request?: { signal?: AbortSignal } }) => {
        signals.push(input.request?.signal);
        return { data: {} };
      },
    );
    mockOctokit.repos.getContent.mockImplementation(
      async (input: { path: string; request?: { signal?: AbortSignal } }) => {
        signals.push(input.request?.signal);
        if (input.path === "") return { data: [] };
        throw absent();
      },
    );

    await createGitHubProfileSource(AUTH, "acme/api").loadProfile();

    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    // One signal object shared by every request: a timeout per request would
    // let a provider that answers slowly but never hangs spend minutes here,
    // and the caller's own bound assumes this half costs at most a minute.
    expect(new Set(signals).size).toBe(1);
  });

  it("gives up the whole read when the shared deadline has already fired", async () => {
    mockOctokit.repos.get.mockImplementation(
      async (input: { request?: { signal?: AbortSignal } }) => {
        input.request?.signal?.throwIfAborted();
        return { data: { default_branch: "main", description: "" } };
      },
    );
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());

    await expect(
      createGitHubProfileSource(AUTH, "acme/api").loadProfile(),
    ).rejects.toThrow();
    vi.mocked(AbortSignal.timeout).mockRestore();
  });

  it("lets a failure that is not a missing path reach the caller", async () => {
    mockOctokit.repos.get.mockRejectedValue(
      Object.assign(new Error("Bad credentials"), { status: 401 }),
    );
    mockOctokit.repos.getReadme.mockRejectedValue(absent());
    mockOctokit.repos.listLanguages.mockResolvedValue({ data: {} });
    mockOctokit.repos.getContent.mockResolvedValue({ data: [] });

    await expect(
      createGitHubProfileSource(AUTH, "acme/api").loadProfile(),
    ).rejects.toThrow("Bad credentials");
  });
});
