import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOctokit = {
  apps: {
    listReposAccessibleToInstallation: vi.fn(),
  },
  paginate: vi.fn(),
};

vi.mock("../../lib/github-auth.js", () => ({
  buildOctokit: vi.fn(() => mockOctokit),
}));

import {
  createRepositoryDirectory,
  createRepositoryDirectoryForProviders,
  filterPinnedRepositories,
  isRepositoryWithinPinnedScope,
  listRepositoriesAcrossProviders,
  pinnedScopeExcludesProvider,
} from "./repository-directory.js";

const mockFetch = vi.fn();

function gitLabResponse(
  body: unknown,
  options: { headers?: Record<string, string> } = {},
) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(options.headers ?? {}),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function gitLabErrorResponse(status: number, statusText: string) {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(""),
  };
}

function gitLabProject(pathWithNamespace: string) {
  return {
    path_with_namespace: pathWithNamespace,
    name: pathWithNamespace.split("/").at(-1),
    namespace: { full_path: pathWithNamespace.split("/")[0] },
    default_branch: "main",
    description: "",
    web_url: `https://gitlab.example.com/${pathWithNamespace}`,
    topics: [],
    archived: false,
    visibility: "private",
  };
}

const githubProvider = {
  kind: "github" as const,
  auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
  host: "https://github.com",
  legacyBaseBranch: "main",
};

const gitlabProvider = {
  kind: "gitlab" as const,
  token: "glpat",
  host: "https://gitlab.example.com",
  legacyBaseBranch: "main",
};

describe("createRepositoryDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("lists GitHub installation repositories with normalized metadata", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        full_name: "acme/api",
        name: "api",
        owner: { login: "acme" },
        default_branch: "main",
        description: "Billing API",
        html_url: "https://github.com/acme/api",
        topics: ["backend"],
        archived: false,
        private: true,
      },
    ]);

    const directory = createRepositoryDirectory({
      kind: "github",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
      repoPath: "default/repo",
      baseBranch: "main",
      host: "https://github.com",
    });

    await expect(directory.listRepositories()).resolves.toEqual([
      {
        provider: "github",
        repoPath: "acme/api",
        name: "api",
        owner: "acme",
        defaultBranch: "main",
        description: "Billing API",
        webUrl: "https://github.com/acme/api",
        topics: ["backend"],
        archived: false,
        private: true,
      },
    ]);
    expect(mockOctokit.paginate).toHaveBeenCalledWith(
      mockOctokit.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
  });

  it("preserves a missing GitHub default branch as unusable metadata", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        full_name: "acme/empty",
        name: "empty",
        owner: { login: "acme" },
        default_branch: null,
        description: null,
        html_url: "https://github.com/acme/empty",
        archived: false,
        private: true,
      },
    ]);
    const directory = createRepositoryDirectory({
      kind: "github",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
      repoPath: "default/repo",
      baseBranch: "main",
      host: "https://github.com",
    });

    await expect(directory.listRepositories()).resolves.toEqual([
      expect.objectContaining({ repoPath: "acme/empty", defaultBranch: "" }),
    ]);
  });

  it("returns provider-visible repositories without applying the runtime allowlist", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/allowed";
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        full_name: "acme/outside-env-allowlist",
        name: "outside-env-allowlist",
        owner: { login: "acme" },
        default_branch: "main",
        description: "",
        html_url: "https://github.com/acme/outside-env-allowlist",
        topics: [],
        archived: false,
        private: true,
      },
    ]);

    try {
      await expect(
        createRepositoryDirectory(githubProvider).listRepositories(),
      ).resolves.toEqual([
        expect.objectContaining({
          provider: "github",
          repoPath: "acme/outside-env-allowlist",
        }),
      ]);
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("lists GitLab accessible projects with normalized metadata", async () => {
    mockFetch
      .mockResolvedValueOnce(gitLabResponse([
        {
          path_with_namespace: "acme/api",
          name: "api",
          namespace: { full_path: "acme" },
          default_branch: "main",
          description: "Billing API",
          web_url: "https://gitlab.example.com/acme/api",
          topics: ["backend"],
          archived: false,
          visibility: "private",
        },
      ], { headers: { "x-next-page": "2" } }))
      .mockResolvedValueOnce(gitLabResponse([], { headers: { "x-next-page": "" } }));

    const directory = createRepositoryDirectory({
      kind: "gitlab",
      token: "glpat",
      repoPath: "default/repo",
      baseBranch: "main",
      host: "https://gitlab.example.com",
    });

    await expect(directory.listRepositories()).resolves.toEqual([
      {
        provider: "gitlab",
        repoPath: "acme/api",
        name: "api",
        owner: "acme",
        defaultBranch: "main",
        description: "Billing API",
        webUrl: "https://gitlab.example.com/acme/api",
        topics: ["backend"],
        archived: false,
        private: true,
      },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "https://gitlab.example.com/api/v4/projects?membership=true&simple=true&per_page=100&page=1",
    );
    expect(mockFetch.mock.calls[0][1]).toMatchObject({
      headers: { "PRIVATE-TOKEN": "glpat" },
      signal: expect.any(AbortSignal),
    });
  });

  it("throws a clear error when GitLab repository discovery times out", async () => {
    const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
    mockFetch.mockRejectedValueOnce(timeoutError);

    const directory = createRepositoryDirectory({
      kind: "gitlab",
      token: "glpat",
      repoPath: "default/repo",
      baseBranch: "main",
      host: "https://gitlab.example.com",
    });

    await expect(directory.listRepositories()).rejects.toThrow(
      "GitLab projects list timed out",
    );
  });

  it("merges repositories from every configured provider", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        full_name: "acme/web",
        name: "web",
        owner: { login: "acme" },
        default_branch: "main",
        description: "Storefront",
        html_url: "https://github.com/acme/web",
        topics: [],
        archived: false,
        private: true,
      },
    ]);
    mockFetch.mockResolvedValueOnce(gitLabResponse([
      {
        path_with_namespace: "acme/api",
        name: "api",
        namespace: { full_path: "acme" },
        default_branch: "main",
        description: "API",
        web_url: "https://gitlab.example.com/acme/api",
        topics: [],
        archived: false,
        visibility: "private",
      },
    ]));

    const directory = createRepositoryDirectoryForProviders([
      {
        kind: "github",
        auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
        host: "https://github.com",
        legacyBaseBranch: "main",
      },
      {
        kind: "gitlab",
        token: "glpat",
        host: "https://gitlab.example.com",
        legacyBaseBranch: "main",
      },
    ]);

    await expect(directory.listRepositories()).resolves.toEqual([
      expect.objectContaining({ provider: "github", repoPath: "acme/web" }),
      expect.objectContaining({ provider: "gitlab", repoPath: "acme/api" }),
    ]);
  });
});

describe("provider listing resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("retries a GitLab 5xx once and keeps the recovered listing", async () => {
    mockFetch
      .mockResolvedValueOnce(gitLabErrorResponse(503, "Service Unavailable"))
      .mockResolvedValueOnce(gitLabResponse([gitLabProject("acme/api")]));

    const listing = await listRepositoriesAcrossProviders([gitlabProvider]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(listing.failures).toEqual([]);
    expect(listing.repositories).toEqual([
      expect.objectContaining({ provider: "gitlab", repoPath: "acme/api" }),
    ]);
  });

  it("retries a transient GitLab timeout and keeps the recovered listing", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    mockFetch
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(gitLabResponse([gitLabProject("acme/api")]));

    const listing = await listRepositoriesAcrossProviders([gitlabProvider]);

    // Two transient timeouts still resolve on the third, bounded attempt.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(listing.failures).toEqual([]);
    expect(listing.repositories).toEqual([
      expect.objectContaining({ provider: "gitlab", repoPath: "acme/api" }),
    ]);
  });

  it("stops after the bounded attempts and reports a GitLab timeout that never clears", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    mockFetch.mockRejectedValue(timeout);

    const listing = await listRepositoriesAcrossProviders([gitlabProvider]);

    // Retries are bounded: three attempts, then the failure surfaces with a
    // reason instead of the retry ladder spinning forever.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(listing.repositories).toEqual([]);
    expect(listing.failures).toEqual([
      expect.objectContaining({
        provider: "gitlab",
        message: expect.stringContaining("GitLab projects list timed out"),
      }),
    ]);
  });

  // A rejected credential is replayed unchanged by a retry, so retrying only
  // doubles the time to a failure the operator has to fix by hand.
  it("never retries a GitLab 401", async () => {
    mockFetch.mockResolvedValue(gitLabErrorResponse(401, "Unauthorized"));

    const listing = await listRepositoriesAcrossProviders([gitlabProvider]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(listing.failures).toEqual([
      expect.objectContaining({
        provider: "gitlab",
        message: "GitLab projects list failed: 401 Unauthorized",
      }),
    ]);
  });

  it("retries a GitHub 5xx and never retries a GitHub 403", async () => {
    mockOctokit.paginate
      .mockRejectedValueOnce(Object.assign(new Error("server error"), { status: 500 }))
      .mockResolvedValueOnce([]);

    await listRepositoriesAcrossProviders([githubProvider]);
    expect(mockOctokit.paginate).toHaveBeenCalledTimes(2);

    mockOctokit.paginate.mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );
    const forbidden = await listRepositoriesAcrossProviders([githubProvider]);

    expect(mockOctokit.paginate).toHaveBeenCalledTimes(3);
    expect(forbidden.failures).toEqual([
      expect.objectContaining({ provider: "github" }),
    ]);
  });

  it("returns the surviving provider's repositories alongside the failed provider", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        full_name: "acme/web",
        name: "web",
        owner: { login: "acme" },
        default_branch: "main",
        description: "Storefront",
        html_url: "https://github.com/acme/web",
        topics: [],
        archived: false,
        private: true,
      },
    ]);
    mockFetch.mockResolvedValue(gitLabErrorResponse(503, "Service Unavailable"));

    const listing = await listRepositoriesAcrossProviders([
      githubProvider,
      gitlabProvider,
    ]);

    expect(listing.repositories).toEqual([
      expect.objectContaining({ provider: "github", repoPath: "acme/web" }),
    ]);
    expect(listing.failures).toEqual([
      expect.objectContaining({ provider: "gitlab" }),
    ]);
  });

  // The fan-out directory has no partial-catalog contract, so its callers keep
  // seeing the provider's own error.
  it("keeps a provider failure terminal for the merged directory", async () => {
    mockOctokit.paginate.mockResolvedValue([]);
    mockFetch.mockResolvedValue(gitLabErrorResponse(503, "Service Unavailable"));

    await expect(
      createRepositoryDirectoryForProviders([
        githubProvider,
        gitlabProvider,
      ]).listRepositories(),
    ).rejects.toThrow("GitLab projects list failed: 503 Service Unavailable");
  });
});

describe("definition repository pin", () => {
  const listed = [
    { provider: "github" as const, repoPath: "Acme/Web" },
    { provider: "github" as const, repoPath: "acme/api" },
    { provider: "gitlab" as const, repoPath: "acme/web" },
  ];

  it("returns the listing untouched for an absent or empty scope", () => {
    expect(filterPinnedRepositories(listed, undefined)).toBe(listed);
    expect(filterPinnedRepositories(listed, {})).toBe(listed);
    expect(
      filterPinnedRepositories(listed, { repositories: [], providers: [] }),
    ).toBe(listed);
  });

  it("intersects on a case-insensitive provider-scoped key", () => {
    expect(
      filterPinnedRepositories(listed, {
        repositories: [{ provider: "github", repoPath: "acme/web" }],
      }),
    ).toEqual([{ provider: "github", repoPath: "Acme/Web" }]);
  });

  it("applies the provider filter and the repository filter together", () => {
    expect(
      filterPinnedRepositories(listed, {
        providers: ["gitlab"],
        repositories: [
          { provider: "github", repoPath: "acme/web" },
          { provider: "gitlab", repoPath: "acme/web" },
        ],
      }),
    ).toEqual([{ provider: "gitlab", repoPath: "acme/web" }]);
  });

  // The pin is an intersection over what the server already offered: it can only
  // remove entries, never add one the listing did not contain.
  it("never admits a repository outside the listing", () => {
    expect(
      filterPinnedRepositories(listed, {
        repositories: [{ provider: "github", repoPath: "acme/secret" }],
      }),
    ).toEqual([]);
  });

  it("answers whether a provider is outside the pin from the same filter", () => {
    expect(pinnedScopeExcludesProvider(undefined, "gitlab")).toBe(false);
    expect(pinnedScopeExcludesProvider({}, "gitlab")).toBe(false);
    expect(
      pinnedScopeExcludesProvider({ providers: ["github"] }, "gitlab"),
    ).toBe(true);
    expect(
      pinnedScopeExcludesProvider({ providers: ["github", "gitlab"] }, "gitlab"),
    ).toBe(false);
    // A pin that names repositories without naming providers still excludes every
    // provider none of those repositories belong to.
    expect(
      pinnedScopeExcludesProvider(
        { repositories: [{ provider: "github", repoPath: "acme/web" }] },
        "gitlab",
      ),
    ).toBe(true);
    expect(
      pinnedScopeExcludesProvider(
        {
          providers: ["github"],
          repositories: [{ provider: "gitlab", repoPath: "acme/web" }],
        },
        "gitlab",
      ),
    ).toBe(true);
  });

  it("answers the single-subject question from the same filter", () => {
    const scope = {
      providers: ["github" as const],
      repositories: [{ provider: "github" as const, repoPath: "Acme/Web" }],
    };
    expect(
      isRepositoryWithinPinnedScope(scope, { provider: "github", repoPath: "acme/WEB" }),
    ).toBe(true);
    expect(
      isRepositoryWithinPinnedScope(scope, { provider: "gitlab", repoPath: "acme/web" }),
    ).toBe(false);
    expect(
      isRepositoryWithinPinnedScope(undefined, { provider: "gitlab", repoPath: "x/y" }),
    ).toBe(true);
  });
});
