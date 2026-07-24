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
  remoteBranchSha?: string | null;
  allowed?: boolean;
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
    getBranchShaIfExists: vi.fn().mockResolvedValue(overrides.remoteBranchSha ?? null),
    createBranchIfMissing: vi.fn().mockResolvedValue(overrides.createResult ?? "created"),
    resetOwnedBranch: vi.fn().mockResolvedValue(undefined),
    recordOwnedBranch: vi.fn().mockResolvedValue(undefined),
    removeOwnedBranch: vi.fn().mockResolvedValue(undefined),
    assertRepositoryAllowed: vi.fn(async () => {
      if (overrides.allowed === false) throw new Error("not in AGENT_ALLOWED_REPOS");
    }),
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
    const { sandbox, controller } = setup({ remoteBranchSha: "foreign-sha" });

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

  it("reuses an existing ticket-owned branch during approved continuation", async () => {
    const approvedManifest: WorkspaceManifestV2 = {
      version: 2,
      repositories: [{
        ...manifest.repositories[0]!,
        branchName: "blazebot/aiw-147",
        workflowOwnedBranch: { branchName: "blazebot/aiw-147" },
      }],
    };
    const { sandbox, controller } = setup({
      ownedBranch: { branchName: "blazebot/aiw-147" },
      remoteBranchSha: "base-sha",
    });

    await expect(promoteRepositoryWriteScope({
      sandbox,
      manifest: approvedManifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "approved" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
    })).resolves.toMatchObject({
      repositories: [expect.objectContaining({ access: "write" })],
    });
    expect(controller.createBranchIfMissing).not.toHaveBeenCalled();
    expect(controller.resetOwnedBranch).not.toHaveBeenCalled();
  });

  it("preflights every collision before recording ownership or mutating a provider", async () => {
    const second = {
      ...manifest.repositories[0]!,
      repoPath: "acme/web",
      slug: "github__acme__web",
      localPath: "/vercel/sandbox/repos/github__acme__web",
    };
    const multi: WorkspaceManifestV2 = {
      version: 2,
      repositories: [manifest.repositories[0]!, second],
    };
    const { sandbox, controller } = setup();
    controller.getBranchShaIfExists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("foreign-sha");

    await expect(promoteRepositoryWriteScope({
      sandbox,
      manifest: multi,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "change" },
        { provider: "github", repoPath: "acme/web", rationale: "change" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
    })).rejects.toThrow("not owned by this ticket");

    expect(controller.recordOwnedBranch).not.toHaveBeenCalled();
    expect(controller.createBranchIfMissing).not.toHaveBeenCalled();
  });

  it("rechecks the allowlist immediately before ownership and provider mutations", async () => {
    const { sandbox, controller } = setup({ allowed: false });

    await expect(promoteRepositoryWriteScope({
      sandbox,
      manifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "change" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
    })).rejects.toThrow("AGENT_ALLOWED_REPOS");

    expect(controller.recordOwnedBranch).not.toHaveBeenCalled();
    expect(controller.createBranchIfMissing).not.toHaveBeenCalled();
  });

  it("checks out the provider-verified SHA without passing credentials to sandbox git", async () => {
    const { sandbox, controller } = setup();
    await promoteRepositoryWriteScope({
      sandbox,
      manifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "change" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
    });

    const flattened = sandbox.runCommand.mock.calls.flatMap(([, args]) => args);
    expect(flattened).not.toContain("fetch");
    expect(flattened.join(" ")).not.toContain("AUTHORIZATION");
    expect(flattened).toContain("base-sha");
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
