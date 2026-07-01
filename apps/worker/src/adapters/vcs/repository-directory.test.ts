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

import { createRepositoryDirectory } from "./repository-directory.js";

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
    });
  });
});
