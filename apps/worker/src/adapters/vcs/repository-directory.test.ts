import { describe, expect, it, vi } from "vitest";

const paginate = vi.fn();
vi.mock("./github-auth.js", () => ({
  buildOctokit: () => ({
    apps: { listReposAccessibleToInstallation: vi.fn() },
    paginate,
  }),
}));

import {
  createRepositoryDirectory,
  filterPinnedRepositories,
  isRepositoryWithinPinnedScope,
} from "./repository-directory.js";

describe("repository directory", () => {
  it("normalizes repositories from the remaining core provider", async () => {
    paginate.mockResolvedValueOnce([{
      full_name: "acme/api",
      name: "api",
      owner: { login: "acme" },
      default_branch: "main",
      description: "Billing API",
      html_url: "https://github.com/acme/api",
      topics: ["backend"],
      archived: false,
      private: true,
    }]);
    const directory = createRepositoryDirectory({
      kind: "github",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
      host: "https://github.com",
    });
    await expect(directory.listRepositories()).resolves.toEqual([
      expect.objectContaining({ provider: "github", repoPath: "acme/api" }),
    ]);
  });

  it("filters an open provider id through the stored scope", () => {
    const repositories = [
      { provider: "forgejo", repoPath: "acme/api" },
      { provider: "github", repoPath: "acme/web" },
    ];
    const scope = { providers: ["forgejo"] };
    expect(filterPinnedRepositories(repositories, scope)).toEqual([repositories[0]]);
    expect(isRepositoryWithinPinnedScope(scope, repositories[0]!)).toBe(true);
  });
});
