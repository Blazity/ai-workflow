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
