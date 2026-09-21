import { describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/vcs/github.js", () => ({
  GitHubAdapter: vi.fn().mockImplementation((config) => ({ kind: "github-test", config })),
}));

import { createVCSForRepository } from "./create-vcs.js";

describe("createVCSForRepository", () => {
  it("creates a GitHub adapter for an arbitrary selected repository", () => {
    const adapter = createVCSForRepository(
      {
        kind: "github",
        auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
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

  it("rejects malformed GitHub repository paths", () => {
    expect(() =>
      createVCSForRepository(
        {
          kind: "github",
          auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
          host: "https://github.com",
        },
        { repoPath: "missing-owner", baseBranch: "main" },
      ),
    ).toThrow(/expected exactly "owner\/repo"/);
  });
});
