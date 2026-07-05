import { describe, expect, it, vi } from "vitest";

vi.mock("../../env.js", () => ({
  getVcsConfig: vi.fn(),
}));

vi.mock("../adapters/vcs/github.js", () => ({
  GitHubAdapter: vi.fn().mockImplementation((config) => ({ kind: "github-test", config })),
}));

vi.mock("../adapters/vcs/gitlab.js", () => ({
  GitLabAdapter: vi.fn().mockImplementation((config) => ({ kind: "gitlab-test", config })),
}));

import { createVCSForRepository } from "./create-vcs.js";

describe("createVCSForRepository", () => {
  it("creates a GitHub adapter for an arbitrary selected repository", () => {
    const adapter = createVCSForRepository(
      {
        kind: "github",
        auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
        repoPath: "default/repo",
        baseBranch: "main",
        host: "https://github.com",
      },
      { repoPath: "org/api", baseBranch: "develop" },
    ) as any;

    expect(adapter.config).toMatchObject({
      owner: "org",
      repo: "api",
      baseBranch: "develop",
    });
  });

  it("creates a GitLab adapter for an arbitrary selected repository", () => {
    const adapter = createVCSForRepository(
      {
        kind: "gitlab",
        token: "glpat",
        repoPath: "default/repo",
        baseBranch: "main",
        host: "https://gitlab.example.com",
      },
      { repoPath: "group/service", baseBranch: "trunk" },
    ) as any;

    expect(adapter.config).toMatchObject({
      token: "glpat",
      projectId: "group/service",
      baseBranch: "trunk",
      host: "https://gitlab.example.com",
    });
  });

  it("rejects malformed GitHub repository paths", () => {
    expect(() =>
      createVCSForRepository(
        {
          kind: "github",
          auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
          repoPath: "default/repo",
          baseBranch: "main",
          host: "https://github.com",
        },
        { repoPath: "missing-owner", baseBranch: "main" },
      ),
    ).toThrow(/expected exactly "owner\/repo"/);
  });
});
