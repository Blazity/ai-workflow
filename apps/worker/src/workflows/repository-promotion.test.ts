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
  ownedBranch?: { branchName: string; publishedHeadSha?: string } | null;
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

  it("reports the moved branch and cuts from the research baseline when the default branch moved during research", async () => {
    const { sandbox, controller } = setup({ defaultSha: "new-default-sha" });
    const onResearchBranchMoved = vi.fn();

    const result = await promoteRepositoryWriteScope({
      sandbox,
      manifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "implementation" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
      onResearchBranchMoved,
    });

    expect(result.repositories[0]).toMatchObject({ access: "write" });
    expect(onResearchBranchMoved).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/api",
      expected: "base-sha",
      actual: "new-default-sha",
    });
    expect(controller.createBranchIfMissing).toHaveBeenCalledWith(
      expect.anything(),
      "blazebot/aiw-147",
      "base-sha",
    );
  });

  it("records the created branch head without re-reading the fresh ref", async () => {
    // GitHub's ref API can 404 for a moment after createRef. This step has no
    // retries, so re-reading the branch it had just created failed healthy runs.
    // The created head is exactly researchBaseSha, so no provider read is needed.
    const { sandbox, controller } = setup();
    controller.getBranchSha = vi.fn(async () => {
      throw new Error("Not Found - https://docs.github.com/rest/git/refs");
    });

    const result = await promoteRepositoryWriteScope({
      sandbox,
      manifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "implementation" },
      ],
      branchName: "ai-workflow/awp-22",
      controller,
      providers,
    });

    expect(controller.getBranchSha).not.toHaveBeenCalled();
    expect(controller.createBranchIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: "acme/api" }),
      "ai-workflow/awp-22",
      "base-sha",
    );
    expect(result.repositories[0]).toMatchObject({
      access: "write",
      expectedRemoteSha: "base-sha",
      preAgentSha: "base-sha",
    });
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

  it("fetches the owned branch before checkout on the reuse path", async () => {
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

    await promoteRepositoryWriteScope({
      sandbox,
      manifest: approvedManifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "approved" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
    });

    const gitCalls = sandbox.runCommand.mock.calls.filter(
      ([command]) => command === "git",
    );
    const fetchIndex = gitCalls.findIndex(([, args]) => args.includes("fetch"));
    const checkoutIndex = gitCalls.findIndex(([, args]) => args.includes("checkout"));
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeLessThan(checkoutIndex);
    const fetchArgs = gitCalls[fetchIndex]![1];
    expect(fetchArgs).toContain("blazebot/aiw-147");
    expect(fetchArgs.join(" ")).toContain("AUTHORIZATION");
  });

  it("resets a recovered owned branch to the research baseline", async () => {
    const { sandbox, controller } = setup({
      ownedBranch: { branchName: "blazebot/aiw-147" },
      remoteBranchSha: "base-sha",
    });

    await promoteRepositoryWriteScope({
      sandbox,
      manifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "reset" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
    });

    expect(controller.resetOwnedBranch).toHaveBeenCalledWith(
      expect.anything(),
      "blazebot/aiw-147",
      "base-sha",
    );
    expect(controller.createBranchIfMissing).not.toHaveBeenCalled();
    expect(
      sandbox.runCommand.mock.calls.flatMap(([, args]) => args),
    ).not.toContain("fetch");
  });

  it("refuses to reset an owned branch that diverged from its published head", async () => {
    const { sandbox, controller } = setup({
      ownedBranch: { branchName: "blazebot/aiw-147", publishedHeadSha: "published-sha" },
      remoteBranchSha: "human-pushed-sha",
    });

    await expect(
      promoteRepositoryWriteScope({
        sandbox,
        manifest,
        writeRepositories: [
          { provider: "github", repoPath: "acme/api", rationale: "reset" },
        ],
        branchName: "blazebot/aiw-147",
        controller,
        providers,
      }),
    ).rejects.toThrow("diverged from its last published head");

    expect(controller.resetOwnedBranch).not.toHaveBeenCalled();
  });

  it("resets an owned branch that still matches its published head", async () => {
    const { sandbox, controller } = setup({
      ownedBranch: { branchName: "blazebot/aiw-147", publishedHeadSha: "published-sha" },
      remoteBranchSha: "published-sha",
    });

    await promoteRepositoryWriteScope({
      sandbox,
      manifest,
      writeRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "reset" },
      ],
      branchName: "blazebot/aiw-147",
      controller,
      providers,
    });

    expect(controller.resetOwnedBranch).toHaveBeenCalled();
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

  it("keeps the shared ledger row when a concurrent same-ticket run wins the create race", async () => {
    const { sandbox, controller } = setup({
      ownedBranch: null,
      remoteBranchSha: null,
      createResult: "existing",
    });

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
    ).rejects.toThrow("concurrent promotion of the same ticket");

    // The shared ledger row survives: promotion records ownership and has no
    // teardown path, so the winning concurrent run keeps the branch it owns.
    expect(controller.recordOwnedBranch).toHaveBeenCalled();
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

  it("points at an earlier identity-resolution failure when a provider is unconfigured", async () => {
    const { sandbox, controller } = setup();
    const gitlabManifest: WorkspaceManifestV2 = {
      version: 2,
      repositories: [
        {
          provider: "gitlab",
          repoPath: "acme/contracts",
          slug: "gitlab__acme__contracts",
          localPath: "/vercel/sandbox/repos/gitlab__acme__contracts",
          defaultBranch: "main",
          branchName: "main",
          selectedRationale: "shared",
          access: "read",
          researchBaseSha: "base-sha",
        },
      ],
    };

    await expect(
      promoteRepositoryWriteScope({
        sandbox,
        manifest: gitlabManifest,
        writeRepositories: [
          { provider: "gitlab", repoPath: "acme/contracts", rationale: "write" },
        ],
        branchName: "blazebot/aiw-147",
        controller,
        providers, // only github is configured
      }),
    ).rejects.toThrow("identity resolution may have failed earlier");
  });
});
