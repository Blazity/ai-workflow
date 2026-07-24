import { describe, expect, it, vi } from "vitest";
import type { WorkspaceManifestV2 } from "../sandbox/repo-workspace.js";
import { promoteRepositoryWriteScope } from "./repository-promotion.js";

const manifest: WorkspaceManifestV2 = {
  version: 2,
  repositories: [
    {
      provider: "github",
      repoPath: "acme/api",
      slug: "github__acme__api",
      localPath: "/vercel/sandbox/repos/github__acme__api",
      defaultBranch: "main",
      branchName: "main",
      selectedRationale: "ticket",
      access: "read",
      researchBaseSha: "base-sha",
    },
  ],
};
const providers = [
  {
    kind: "github" as const,
    host: "https://github.com",
    getToken: async () => "secret-token",
  },
];

function commandResult(stdout = "", exitCode = 0) {
  return {
    exitCode,
    stdout: async () => stdout,
    stderr: async () => "",
  };
}

function setup(overrides: {
  status?: string;
  head?: string;
  defaultSha?: string;
  ownedBranch?: { branchName: string } | null;
  createResult?: "created" | "existing";
} = {}) {
  const sandbox = {
    runCommand: vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args.includes("status")) {
        return commandResult(overrides.status ?? "");
      }
      if (command === "git" && args.includes("rev-parse")) {
        return commandResult(overrides.head ?? "base-sha");
      }
      return commandResult();
    }),
    writeFiles: vi.fn().mockResolvedValue(undefined),
  };
  const controller = {
    getResearchBranchSha: vi.fn().mockResolvedValue(overrides.defaultSha ?? "base-sha"),
    findOwnedBranch: vi.fn().mockResolvedValue(overrides.ownedBranch ?? null),
    createBranchIfMissing: vi.fn().mockResolvedValue(overrides.createResult ?? "created"),
    resetOwnedBranch: vi.fn().mockResolvedValue(undefined),
    recordOwnedBranch: vi.fn().mockResolvedValue(undefined),
    getBranchSha: vi.fn().mockResolvedValue("base-sha"),
  };
  return { sandbox, controller };
}

describe("repository write-scope promotion", () => {
  it("creates, records, checks out, and atomically marks an exact repository writable", async () => {
    const { sandbox, controller } = setup();

    const result = await promoteRepositoryWriteScope({
      sandbox,
      manifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "implementation" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
    });

    expect(controller.recordOwnedBranch).toHaveBeenCalled();
    expect(result.repositories[0]).toMatchObject({
      access: "write",
      branchName: "blazebot/aiw-147",
      preAgentSha: "base-sha",
      expectedRemoteSha: "base-sha",
    });
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        path: expect.stringContaining("aiw-repos.json.tmp-"),
      }),
    ]);
    expect(
      sandbox.runCommand.mock.calls.flatMap(([, args]) => args),
    ).not.toContain("secret-token");
  });

  it("rejects a dirty research checkout before any provider mutation", async () => {
    const { sandbox, controller } = setup({ status: " M src/index.ts" });

    await expect(
      promoteRepositoryWriteScope({
        sandbox,
        manifest,
        writeRepositories: [
          { provider: "github", repoPath: "acme/api", rationale: "implementation" },
        ],
        branchName: "blazebot/aiw-147",
        controller,
        providers,
      }),
    ).rejects.toThrow("dirty");

    expect(controller.createBranchIfMissing).not.toHaveBeenCalled();
    expect(controller.resetOwnedBranch).not.toHaveBeenCalled();
  });

  it("rejects a moved default head before mutation", async () => {
    const { sandbox, controller } = setup({ defaultSha: "new-default-sha" });

    await expect(
      promoteRepositoryWriteScope({
        sandbox,
        manifest,
        writeRepositories: [
          { provider: "github", repoPath: "acme/api", rationale: "implementation" },
        ],
        branchName: "blazebot/aiw-147",
        controller,
        providers,
      }),
    ).rejects.toThrow("research branch moved");
  });

  it("never resets a same-named foreign branch", async () => {
    const { sandbox, controller } = setup({ createResult: "existing" });

    await expect(
      promoteRepositoryWriteScope({
        sandbox,
        manifest,
        writeRepositories: [
          { provider: "github", repoPath: "acme/api", rationale: "implementation" },
        ],
        branchName: "blazebot/aiw-147",
        controller,
        providers,
      }),
    ).rejects.toThrow("not owned by this ticket");

    expect(controller.resetOwnedBranch).not.toHaveBeenCalled();
    expect(controller.recordOwnedBranch).not.toHaveBeenCalled();
  });

  it("rejects an unknown write repository", async () => {
    const { sandbox, controller } = setup();

    await expect(
      promoteRepositoryWriteScope({
        sandbox,
        manifest,
        writeRepositories: [
          { provider: "gitlab", repoPath: "acme/unknown", rationale: "guess" },
        ],
        branchName: "blazebot/aiw-147",
        controller,
        providers,
      }),
    ).rejects.toThrow("not attached");
  });
});
