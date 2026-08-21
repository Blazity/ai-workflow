import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    AGENT_KIND: "claude",
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_API_KEY: "codex-key",
    CLAUDE_MODEL: "claude-model",
    CODEX_MODEL: "codex-model",
    JOB_TIMEOUT_MS: 1000,
    ENABLE_REPO_MEMORY: true,
  } as Record<string, unknown>,
  runPreSandboxPhase: vi.fn(),
  blockFetchPrContextsStep: vi.fn(),
  blockPrTriggerRepositoriesStep: vi.fn(),
  provisionMultiRepo: vi.fn(),
  agentInstall: vi.fn(),
  agentConfigure: vi.fn(),
  createAgentAdapter: vi.fn((kind: string) => ({
    kind,
    cliSpec: { displayName: kind, binName: kind },
    install: mocks.agentInstall,
    configure: mocks.agentConfigure,
  })),
  buildSandboxProviderConfigs: vi.fn().mockResolvedValue([]),
  registerSandbox: vi.fn(),
  listRepositories: vi.fn(),
  getBranchSha: vi.fn(),
  getBranchShaIfExists: vi.fn(),
  listWorkflowOwnedBranchesForTicket: vi.fn(),
  promoteRepositoryWriteScopeStep: vi.fn(),
  sandboxGet: vi.fn(),
  hydrateWorkspaceMemoryStep: vi.fn(),
  seedRepoMemoryStep: vi.fn(),
  captureDefaultBranchFilesStep: vi.fn(),
  sandboxManagerCtor: vi.fn(),
  resolveChecksProvisioningStep: vi.fn(),
  runRepositorySetup: vi.fn(),
}));

vi.mock("../../../env.js", () => ({
  env: mocks.env,
  getConfiguredVcsProviders: () => [{ kind: "github" }],
}));
vi.mock("../../pre-sandbox/runner.js", () => ({
  runPreSandboxPhase: mocks.runPreSandboxPhase,
}));
vi.mock("./fetch-pr-context.js", () => ({
  blockFetchPrContextsStep: mocks.blockFetchPrContextsStep,
  blockPrTriggerRepositoriesStep: mocks.blockPrTriggerRepositoriesStep,
  blockPrTriggerRepositoriesWithSiblingsStep: mocks.blockPrTriggerRepositoriesStep,
}));
vi.mock("../repository-promotion.js", () => ({
  promoteRepositoryWriteScopeStep: mocks.promoteRepositoryWriteScopeStep,
}));
vi.mock("../memory-steps.js", () => ({
  hydrateWorkspaceMemoryStep: mocks.hydrateWorkspaceMemoryStep,
}));
vi.mock("../repo-seed-steps.js", () => ({
  seedRepoMemoryStep: mocks.seedRepoMemoryStep,
}));
vi.mock("../repo-memory-steps.js", () => ({
  captureDefaultBranchFilesStep: mocks.captureDefaultBranchFilesStep,
}));
vi.mock("../../sandbox/manager.js", () => ({
  SandboxManager: vi.fn((config: unknown) => {
    mocks.sandboxManagerCtor(config);
    return { provisionMultiRepo: mocks.provisionMultiRepo };
  }),
}));
vi.mock("./pre-pr-checks.js", () => ({
  resolveChecksProvisioningStep: mocks.resolveChecksProvisioningStep,
  runRepositorySetup: mocks.runRepositorySetup,
}));
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: mocks.createAgentAdapter,
}));
vi.mock("../../lib/vcs-runtime.js", () => ({
  buildSandboxProviderConfigs: mocks.buildSandboxProviderConfigs,
  createRepositoryVCS: () => ({
    getBranchSha: mocks.getBranchSha,
    getBranchShaIfExists: mocks.getBranchShaIfExists,
  }),
}));
// The pin predicate is a pure helper in the same module and stays real; only the
// network-backed directory is stubbed.
vi.mock("../../adapters/vcs/repository-directory.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../adapters/vcs/repository-directory.js")
  >()),
  createRepositoryDirectoryForProviders: () => ({
    listRepositories: mocks.listRepositories,
  }),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../db/queries/workflow-owned-branches.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
}));
vi.mock("../../lib/adapters.js", () => ({
  createAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));

import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import {
  ensureWorkspace,
  execute,
  maybePromoteGenericAgentWorkspace,
  maybePromoteTicketWorkspaceWrites,
  paramsSchema,
  researchDeclaredNoWritesGuard,
  sandboxLifetimeMs,
} from "./prepare-workspace.js";
import type { WorkspaceManifestV2 } from "../../sandbox/repo-workspace.js";
import { teardownSandboxes } from "../../sandbox/poll-agent.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeNode,
  makePrPayload,
  runControlErrorCases,
} from "./test-support.js";

const repo: SelectedRepository = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "ticket mentions api",
};

// Approved-scope researchBaseSha values must be 40-hex (a real commit SHA).
const BASE_SHA = "a".repeat(40);
const MOVED_SHA = "b".repeat(40);

function contextsFor(repository: SelectedRepository, hasConflicts = false) {
  return [{ repository, prComments: [], checkResults: [], hasConflicts }];
}

// vi.clearAllMocks() clears calls but keeps implementations, and mocks.env is a
// plain object it never touches at all. Both leak across tests: a memory step
// left rejecting with a run-control error would now fail every later test.
beforeEach(() => {
  mocks.env.ENABLE_REPO_MEMORY = true;
  mocks.hydrateWorkspaceMemoryStep.mockReset();
  mocks.seedRepoMemoryStep.mockReset();
  mocks.captureDefaultBranchFilesStep.mockReset();
  mocks.captureDefaultBranchFilesStep.mockResolvedValue({});
});

describe("sandboxLifetimeMs", () => {
  it("adds the checks ceiling to whatever budget the route sized itself by", () => {
    expect(sandboxLifetimeMs(1_800_000, 3_600_000)).toBe(5_400_000);
  });

  it("covers the clarification restore, which sizes from remaining duration", () => {
    // The regression this rule exists for. A parked run resumes with whatever
    // duration is left, and the checks cap no longer consults that number at
    // all, so a sandbox sized from remaining alone dies under a batch well
    // inside its own bound and reports a lost workspace.
    expect(sandboxLifetimeMs(120_000.7, 3_600_000)).toBe(120_000 + 3_600_000);
  });

  it("never returns a lifetime below one millisecond, ceiling or not", () => {
    expect(sandboxLifetimeMs(0, 0)).toBe(1);
    expect(sandboxLifetimeMs(-5, 0)).toBe(1);
    expect(sandboxLifetimeMs(Number.NaN, 60_000)).toBe(60_001);
  });

  it("ignores a ceiling that is not a usable number", () => {
    expect(sandboxLifetimeMs(1_000, Number.NaN)).toBe(1_000);
    expect(sandboxLifetimeMs(1_000, -1)).toBe(1_000);
  });
});

describe("prepare_workspace paramsSchema", () => {
  it("accepts only empty params", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

/** A definition that reaches the repository scripts engine, which is the only
 *  kind that provisions setup. */
const SCRIPT_NODES = [
  { id: "checks", type: "run_pre_pr_checks", name: "Run pre-PR checks", params: {} },
] as unknown as NonNullable<Parameters<typeof makeCtx>[0]>["definitionNodes"];

describe("prepare_workspace execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No stored configuration and the default ceiling: what a deployment with
    // nothing configured sees, and what every test that is not about the
    // checks phase should get.
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 60 * 60_000,
      config: null,
    });
    mocks.runRepositorySetup.mockResolvedValue({
      ran: 0,
      failures: [],
      summary: "No repository configured setup commands.",
    });
    mocks.buildSandboxProviderConfigs.mockResolvedValue([]);
    mocks.listRepositories.mockResolvedValue([]);
    mocks.getBranchSha.mockResolvedValue(BASE_SHA);
    mocks.getBranchShaIfExists.mockResolvedValue(BASE_SHA);
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([]);
    mocks.sandboxGet.mockResolvedValue({ sandboxId: "sbx-discovery" });
    mocks.agentInstall.mockResolvedValue(undefined);
    mocks.agentConfigure.mockResolvedValue(undefined);
    mocks.provisionMultiRepo.mockImplementation(async (...args: unknown[]) => {
      const lifecycle = args[4] as
        | { onCreated?: (sandboxId: string) => Promise<void> }
        | undefined;
      await lifecycle?.onCreated?.("sbx-9");
      return {
        sandbox: { sandboxId: "sbx-9" },
        workspaceManifest: {
          version: 1,
          repositories: [{
            ...repo,
            slug: "acme__api",
            localPath: "/vercel/sandbox",
            branchName: "blazebot/awt-1",
            preAgentSha: "trusted-sha",
            // A ticket re-picked up with branch ownership the ledger proved: the
            // owned branch IS the run branch, which is what every producer of a
            // manifest entry records. Repo memory seeding reads this field to keep
            // its pruner off a pull request head, so the fixture carries it.
            workflowOwnedBranch: { branchName: "blazebot/awt-1" },
          }],
        },
      };
    });
  });

  it("selects repos, provisions the sandbox, registers it, and mutates the ctx", async () => {
    const promptAdditions = {
      research: [
        { target: ["research"], title: "Selected Repositories", content: "- github:acme/api" },
      ],
      implementation: [],
      review: [],
    };
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions,
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({ sandboxId: null });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.runPreSandboxPhase).toHaveBeenCalledWith({
      ticket: expect.objectContaining({ identifier: "AWT-1" }),
      run: { branchName: "blazebot/awt-1" },
    });
    expect(mocks.provisionMultiRepo).toHaveBeenCalledWith(
      expect.objectContaining({ access: "read" }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(mocks.registerSandbox).toHaveBeenCalledWith(
      "ticket:jira:AWT-1",
      "owner:test",
      "sbx-9",
    );
    expect(ctx.sandboxId).toBe("sbx-9");
    expect(ctx.workspaceManifest).toEqual({
      version: 1,
      repositories: [expect.objectContaining({
        repoPath: "acme/api",
        branchName: "blazebot/awt-1",
        preAgentSha: "trusted-sha",
      })],
    });
    expect(ctx.selectedRepositories).toEqual([repo]);
    expect(ctx.repositoryContexts).toEqual(contextsFor(repo));
    expect(ctx.preSandboxAdditions).toEqual(promptAdditions);
    // Memory hydration runs once, against the manifest the ctx now carries.
    expect(mocks.hydrateWorkspaceMemoryStep).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateWorkspaceMemoryStep).toHaveBeenCalledWith({
      sandboxId: "sbx-9",
      subjectKey: "ticket:jira:AWT-1",
      ticketKey: "AWT-1",
      taskId: "AWT-1",
      workspaceManifest: ctx.workspaceManifest,
      runId: "run-1",
    });
    // Repo memory seeding runs once, over the manifest's repositories reduced to
    // the fields the step addresses a document with plus the branch identity its
    // retraction gate turns on. Those come from this trusted in-memory manifest,
    // never from the sandbox's copy of it: a promoted discovery sandbox has
    // already run agent code, and a rewritten branchName there would switch a
    // destructive prune on over a pull request head.
    expect(mocks.seedRepoMemoryStep).toHaveBeenCalledTimes(1);
    expect(mocks.seedRepoMemoryStep).toHaveBeenCalledWith({
      sandboxId: "sbx-9",
      runId: "run-1",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          localPath: "/vercel/sandbox",
          branchName: "blazebot/awt-1",
          defaultBranch: "main",
          workflowOwnedBranch: "blazebot/awt-1",
        },
      ],
    });
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        sandboxId: "sbx-9",
        repositories: ["github:acme/api"],
        workspace: { id: "sbx-9", repositories: ["github:acme/api"] },
        // Published so the checks blocks bound their batches by the same
        // number the sandbox lifetime above was sized against.
        checksCeilingMs: 60 * 60_000,
      },
    });
    expectOutputConformsToRegistry("prepare_workspace", result.output!);
  });

  // Memory is an optimization. Even an error crossing the step boundary must not
  // fail a workspace that is already provisioned and registered.
  it("still succeeds when memory hydration throws", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.hydrateWorkspaceMemoryStep.mockRejectedValue(new Error("memory step failed"));
    const ctx = makeCtx({ sandboxId: null });

    const result = await ensureWorkspace(ctx, undefined, {});

    expect(result.kind).toBe("next");
    expect(ctx.sandboxId).toBe("sbx-9");
    expect(ctx.selectedRepositories).toEqual([repo]);
  });

  // Same contract for the seed as for the hydration above: an error crossing the
  // step boundary must not fail a workspace that is already provisioned.
  it("still succeeds when repo memory seeding throws", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.seedRepoMemoryStep.mockRejectedValue(new Error("seed step failed"));
    const ctx = makeCtx({ sandboxId: null });

    const result = await ensureWorkspace(ctx, undefined, {});

    expect(result.kind).toBe("next");
    expect(ctx.sandboxId).toBe("sbx-9");
    expect(ctx.selectedRepositories).toEqual([repo]);
  });

  // ENABLE_REPO_MEMORY is the feature's kill switch. With it off the seed step
  // must not be invoked at all: a "use step" call writes a durable step record
  // on every run even when its body returns immediately. Workspace memory
  // hydration is a different feature and stays on.
  it("does not invoke repo memory seeding when ENABLE_REPO_MEMORY is off", async () => {
    mocks.env.ENABLE_REPO_MEMORY = false;
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({ sandboxId: null });

    const result = await ensureWorkspace(ctx, undefined, {});

    expect(mocks.seedRepoMemoryStep).not.toHaveBeenCalled();
    expect(mocks.captureDefaultBranchFilesStep).not.toHaveBeenCalled();
    expect(mocks.hydrateWorkspaceMemoryStep).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("next");
    expect(ctx.sandboxId).toBe("sbx-9");
  });

  // The default-branch listing is the trusted half of the repo-memory absent-path
  // filter. It is taken here because this is the last moment the checkout is
  // still only what the clone produced: the distill that consumes it runs after
  // teardown, against a run whose own branch holds files the default branch does
  // not, so a workspace read there would confirm exactly the entries the listing
  // exists to reject.
  it("captures the default-branch file listing over the trusted manifest", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.captureDefaultBranchFilesStep.mockResolvedValue({
      "github:acme/api": ["README.md", "lib/http.ts"],
    });
    const ctx = makeCtx({ sandboxId: null });

    await ensureWorkspace(ctx, undefined, {});

    // Exactly the fields the seed step gets, and for the same reason: which ref
    // counts as the repository is decided from this in-memory manifest, never
    // from the sandbox's copy of it, because a promoted discovery sandbox has
    // already run agent code.
    expect(mocks.captureDefaultBranchFilesStep).toHaveBeenCalledTimes(1);
    expect(mocks.captureDefaultBranchFilesStep).toHaveBeenCalledWith({
      sandboxId: "sbx-9",
      runId: "run-1",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          localPath: "/vercel/sandbox",
          branchName: "blazebot/awt-1",
          defaultBranch: "main",
          workflowOwnedBranch: "blazebot/awt-1",
        },
      ],
    });
    expect(ctx.defaultBranchFiles).toEqual({
      "github:acme/api": ["README.md", "lib/http.ts"],
    });
  });

  // Its own try/catch, so a seed that failed at the step boundary does not also
  // cost the listing, and neither one may fail a provisioned workspace.
  it("still succeeds and still captures when repo memory seeding throws", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.seedRepoMemoryStep.mockRejectedValue(new Error("seed step failed"));
    mocks.captureDefaultBranchFilesStep.mockResolvedValue({
      "github:acme/api": ["README.md"],
    });
    const ctx = makeCtx({ sandboxId: null });

    const result = await ensureWorkspace(ctx, undefined, {});

    expect(result.kind).toBe("next");
    expect(ctx.defaultBranchFiles).toEqual({ "github:acme/api": ["README.md"] });
  });

  it("still succeeds when the default-branch capture throws", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.captureDefaultBranchFilesStep.mockRejectedValue(new Error("capture failed"));
    const ctx = makeCtx({ sandboxId: null });

    const result = await ensureWorkspace(ctx, undefined, {});

    expect(result.kind).toBe("next");
    expect(ctx.sandboxId).toBe("sbx-9");
    // Left unset rather than set to an empty listing: the distill has to read
    // that as "no information", never as "this repository has no files".
    expect(ctx.defaultBranchFiles).toBeUndefined();
  });

  it.each(runControlErrorCases())(
    "rethrows %s from the default-branch capture",
    async (_label, error) => {
      mocks.runPreSandboxPhase.mockResolvedValue({
        status: "continue",
        promptAdditions: { research: [], implementation: [], review: [] },
        selectedRepositories: [repo],
      });
      mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
      mocks.captureDefaultBranchFilesStep.mockRejectedValue(error);

      await expect(
        ensureWorkspace(makeCtx({ sandboxId: null }), undefined, {}),
      ).rejects.toBe(error);
    },
  );

  // A cancelled or out-of-budget run must stop at the memory call sites too.
  // Swallowing the rejection here would return {kind: "next"} and let a
  // cancelled run keep executing.
  it.each(runControlErrorCases())(
    "rethrows %s from workspace memory hydration",
    async (_label, error) => {
      mocks.runPreSandboxPhase.mockResolvedValue({
        status: "continue",
        promptAdditions: { research: [], implementation: [], review: [] },
        selectedRepositories: [repo],
      });
      mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
      mocks.hydrateWorkspaceMemoryStep.mockRejectedValue(error);

      await expect(
        ensureWorkspace(makeCtx({ sandboxId: null }), undefined, {}),
      ).rejects.toBe(error);
      expect(mocks.seedRepoMemoryStep).not.toHaveBeenCalled();
    },
  );

  it.each(runControlErrorCases())(
    "rethrows %s from repo memory seeding",
    async (_label, error) => {
      mocks.runPreSandboxPhase.mockResolvedValue({
        status: "continue",
        promptAdditions: { research: [], implementation: [], review: [] },
        selectedRepositories: [repo],
      });
      mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
      mocks.seedRepoMemoryStep.mockRejectedValue(error);

      await expect(
        ensureWorkspace(makeCtx({ sandboxId: null }), undefined, {}),
      ).rejects.toBe(error);
    },
  );

  it("passes the clarification answer back into pre-sandbox repository selection", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null }),
      {},
      { clarificationAnswer: "Use github:acme/api" },
    );

    expect(mocks.runPreSandboxPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({
          comments: expect.arrayContaining([
            expect.objectContaining({
              author: "Human clarification",
              body: "Use github:acme/api",
            }),
          ]),
        }),
      }),
    );
  });

  it("marks conflicted repositories with a mergeBase", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo, true));
    const ctx = makeCtx({ sandboxId: null });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(ctx.selectedRepositories[0].mergeBase).toBe("main");
  });

  it("uses server-validated harness discovery before provisioning an ambiguous ticket", async () => {
    const discovery = {
      catalog: [
        {
          provider: "github" as const,
          repoPath: "acme/api",
          name: "api",
          defaultBranch: "main",
          description: "",
          topics: [],
          usable: true,
        },
      ],
      mandatoryRepositories: [],
    };
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      repositoryDiscovery: discovery,
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const discoverRepositories = vi.fn().mockResolvedValue([repo]);
    const ctx = makeCtx({ sandboxId: null });

    const result = await ensureWorkspace(ctx, undefined, {
      discoverRepositories,
    });

    expect(discoverRepositories).toHaveBeenCalledWith(discovery);
    expect(ctx.repositoryDiscovery).toEqual(discovery);
    expect(ctx.selectedRepositories).toEqual([repo]);
    expect(result.kind).toBe("next");
  });

  it("hydrates and promotes the discovery sandbox instead of provisioning a second VM", async () => {
    const discovery = {
      catalog: [{
        provider: "github" as const,
        repoPath: "acme/api",
        name: "api",
        defaultBranch: "main",
        description: "",
        topics: [],
        usable: true,
      }],
      mandatoryRepositories: [],
    };
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      repositoryDiscovery: discovery,
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const discoverRepositories = vi.fn().mockResolvedValue({
      repositories: [repo],
      sandboxId: "sbx-discovery",
    });
    const manifest = {
      version: 2 as const,
      repositories: [{
        ...repo,
        slug: "github__acme__api",
        localPath: "/vercel/sandbox/repos/github__acme__api",
        branchName: "main",
        access: "read" as const,
        researchBaseSha: "base-sha",
      }],
    };
    const hydrateDiscoveredWorkspace = vi.fn().mockResolvedValue(manifest);
    const ctx = makeCtx({
      sandboxId: null,
      agentSandboxIds: { discovery: "sbx-discovery" },
      sandboxIds: new Set(["sbx-discovery"]),
    });

    const result = await ensureWorkspace(ctx, undefined, {
      discoverRepositories,
      hydrateDiscoveredWorkspace,
    });

    expect(hydrateDiscoveredWorkspace).toHaveBeenCalledWith(
      "sbx-discovery",
      [repo],
    );
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
    expect(ctx.agentSandboxIds).toEqual({});
    expect(ctx.sandboxId).toBe("sbx-discovery");
    expect(ctx.workspaceManifest).toBe(manifest);
    // The promotion path reaches the same hydration point as provisioning.
    expect(mocks.hydrateWorkspaceMemoryStep).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateWorkspaceMemoryStep).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx-discovery",
        taskId: "AWT-1",
        workspaceManifest: manifest,
      }),
    );
    expect(result.kind).toBe("next");
  });

  // IM-8: the promoted discovery sandbox only carries the run-default CLI. Install
  // every agent kind the definition needs into it, the same install/configure the
  // provision path performs, or a later different-kind block fails with cli_exit.
  it("installs every required agent kind into the promoted discovery sandbox", async () => {
    const discovery = {
      catalog: [{
        provider: "github" as const,
        repoPath: "acme/api",
        name: "api",
        defaultBranch: "main",
        description: "",
        topics: [],
        usable: true,
      }],
      mandatoryRepositories: [],
    };
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      repositoryDiscovery: discovery,
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const discoverRepositories = vi.fn().mockResolvedValue({
      repositories: [repo],
      sandboxId: "sbx-discovery",
    });
    const manifest = {
      version: 2 as const,
      repositories: [{
        ...repo,
        slug: "github__acme__api",
        localPath: "/vercel/sandbox/repos/github__acme__api",
        branchName: "main",
        access: "read" as const,
        researchBaseSha: "base-sha",
      }],
    };
    const hydrateDiscoveredWorkspace = vi.fn().mockResolvedValue(manifest);
    const ctx = makeCtx({
      sandboxId: null,
      agentSandboxIds: { discovery: "sbx-discovery" },
      sandboxIds: new Set(["sbx-discovery"]),
      // Default run kind is claude; a codex review_agent forces a second CLI.
      definitionNodes: [
        makeNode("planning_agent", {}, "plan-1"),
        makeNode("review_agent", { provider: "codex" }, "rev-1"),
      ],
    });

    const result = await ensureWorkspace(ctx, undefined, {
      discoverRepositories,
      hydrateDiscoveredWorkspace,
    });

    expect(result.kind).toBe("next");
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
    expect(mocks.sandboxGet).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx-discovery" }),
    );
    const installedKinds = mocks.createAgentAdapter.mock.calls.map(
      (call) => call[0],
    );
    expect(installedKinds).toContain("claude");
    expect(installedKinds).toContain("codex");
    expect(mocks.agentInstall).toHaveBeenCalledTimes(2);
    expect(mocks.agentConfigure).toHaveBeenCalledTimes(2);
  });

  it("asks for a narrower scope before provisioning more than 8 repositories", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: Array.from({ length: 9 }, (_, index) => ({
        provider: "github" as const,
        repoPath: `acme/repo-${index}`,
        defaultBranch: "main",
        selectedRationale: "ticket reference",
      })),
    });

    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null }),
    );

    expect(result.kind).toBe("needs_human_input");
    expect(mocks.blockFetchPrContextsStep).not.toHaveBeenCalled();
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
  });

  it("provisions every agent kind the definition resolves to", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({
      sandboxId: null,
      definitionNodes: [
        makeNode("fix_agent", { provider: "codex" }, "fix-1"),
        makeNode("open_pr", {}, "pr-1"),
      ],
    });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    const kinds = mocks.createAgentAdapter.mock.calls.map((call) => call[0]);
    expect(kinds).toContain("claude");
    expect(kinds).toContain("codex");
  });

  it("installs planning but not workspace-free Generic providers into the shared workspace", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({
      sandboxId: null,
      definitionNodes: [
        makeNode("planning_agent", { provider: "codex" }, "plan-1"),
        makeNode(
          "generic_agent",
          { provider: "codex", prompt: "Summarize", workspaceMode: "none" },
          "generic-1",
        ),
        makeNode("implementation_agent", { provider: "claude" }, "impl-1"),
      ],
    });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.createAgentAdapter).toHaveBeenCalledWith("codex", undefined);
    expect(mocks.createAgentAdapter).toHaveBeenCalledWith(
      "claude",
      undefined,
    );
  });

  it("gives the workspace sandbox a lifetime that covers the checks phase too", async () => {
    // The checks run in THIS sandbox and no longer spend the run's duration
    // budget, so a lifetime of JOB_TIMEOUT_MS alone would kill it under a batch
    // that is still well inside its own bound.
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 900_000,
      config: { repositories: [] },
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(mocks.sandboxManagerCtor).toHaveBeenCalledWith(
      expect.objectContaining({ jobTimeoutMs: 1000 + 900_000 }),
    );
  });

  it("runs the configured setup as a substep of workspace creation", async () => {
    const config = { repositories: [{ provider: "github", repoPath: "acme/api" }] };
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 900_000,
      config,
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null, definitionNodes: SCRIPT_NODES }),
    );

    expect(result.kind).toBe("next");
    expect(mocks.runRepositorySetup).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx-9", config, checksCeilingMs: 900_000 }),
    );
    // The plain observer only. Setup is provisioning, so its time is the run's
    // duration and must never be charged to the checks ceiling: three repos of
    // `uv sync` would otherwise eat the budget the tests were given, and the
    // failure would point an operator at batchTimeoutMinutes, the wrong knob.
    expect(mocks.runRepositorySetup.mock.calls[0]![0]).not.toHaveProperty(
      "observeChecksBudget",
    );
  });

  it("runs no setup at all for a definition that never runs repository scripts", async () => {
    // Blast radius. A tenant whose private registry answers 401 would otherwise
    // lose every workflow they have, research-only ones included, to a setup
    // command none of those workflows was ever going to need.
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 900_000,
      config: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
    });
    mocks.runRepositorySetup.mockResolvedValue({
      ran: 1,
      failures: [
        {
          provider: "github",
          repoPath: "acme/api",
          command: "uv sync",
          exitCode: 127,
          stdout: "",
          stderr: "uv: command not found",
          phase: "setup",
        },
      ],
      summary: "Setup failed in 1 of 1 repositories.",
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null, definitionNodes: [] }),
    );

    expect(mocks.runRepositorySetup).not.toHaveBeenCalled();
    expect(result.kind).toBe("next");
  });

  it("fails workspace creation loudly when a setup command fails", async () => {
    // Not a check result and not something a later block routes around: no
    // code edit repairs a missing toolchain, and the operator has a command to
    // go and fix, so the failure names it here instead of surfacing twenty
    // minutes later as a check that timed out.
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 900_000,
      config: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
    });
    mocks.runRepositorySetup.mockResolvedValue({
      ran: 1,
      failures: [
        {
          provider: "github",
          repoPath: "acme/api",
          command: "uv sync",
          exitCode: 127,
          stdout: "",
          stderr: "uv: command not found",
          phase: "setup",
        },
      ],
      summary: "Setup failed in 1 of 1 repositories.",
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null, definitionNodes: SCRIPT_NODES }),
    );

    expect(result).toMatchObject({
      kind: "execution_error",
      error: { category: "checks", phase: "setup" },
    });
    expect(JSON.stringify(result)).toContain("uv sync");
  });

  it("verifies setup on the reuse path too, so a restored workspace cannot skip it", async () => {
    // Reachable from a clarification restore, where the workspace is a fresh
    // sandbox rebuilt from a snapshot. Skipping the substep there would return
    // setup to running inside the first check batch, silently.
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 900_000,
      config: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
    });
    mocks.runRepositorySetup.mockResolvedValue({
      ran: 1,
      failures: [
        {
          provider: "github",
          repoPath: "acme/api",
          command: "uv sync",
          exitCode: 127,
          stdout: "",
          stderr: "uv: command not found",
          phase: "setup",
        },
      ],
      summary: "Setup failed in 1 of 1 repositories.",
    });

    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: "sbx-restored", definitionNodes: SCRIPT_NODES }),
    );

    expect(mocks.runRepositorySetup).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx-restored" }),
    );
    expect(result).toMatchObject({
      kind: "execution_error",
      error: { category: "checks", phase: "setup" },
    });
  });

  it("does not re-resolve the ceiling on reuse once the run has fixed one", async () => {
    // Two ceilings in one run would mean two different bounds for the same
    // phase, and the step record is not worth paying for twice.
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: "sbx-warm", checksCeilingMs: 420_000 }),
    );

    expect(mocks.resolveChecksProvisioningStep).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({ checksCeilingMs: 420_000 });
  });

  it("still creates the workspace when the scripts configuration cannot be read", async () => {
    // Provisioning is not the place to discover a broken checks config. The
    // checks block reports it with the field that broke; failing here would
    // also stop every run whose graph never runs a check.
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 60 * 60_000,
      config: null,
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null }),
    );

    expect(result.kind).toBe("next");
    expect(result.output).toMatchObject({ checksCeilingMs: 60 * 60_000 });
  });

  it("is idempotent and reuses an already attached workspace", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({ status: "continue", selectedRepositories: [repo] });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.provisionMultiRepo.mockResolvedValueOnce({
      sandbox: { sandboxId: "sbx-a" },
      workspaceManifest: {
        version: 1,
        repositories: [{
          ...repo,
          slug: "acme__api",
          localPath: "/vercel/sandbox",
          branchName: "blazebot/awt-1",
          preAgentSha: "trusted-sha",
        }],
      },
    });

    const ctx = makeCtx({ sandboxId: null, sandboxIds: new Set<string>() });

    const first = await execute(makeNode("prepare_workspace"), {}, ctx);
    const second = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(ctx.sandboxId).toBe("sbx-a");
    expect([...ctx.sandboxIds]).toEqual(["sbx-a"]);
    expect(mocks.provisionMultiRepo).toHaveBeenCalledTimes(1);
    expect(mocks.registerSandbox).toHaveBeenLastCalledWith(
      "ticket:jira:AWT-1",
      "owner:test",
      "sbx-a",
    );
    expect(second).toEqual(first);

    const teardown = vi.fn().mockResolvedValue(undefined);
    await teardownSandboxes(ctx.sandboxIds, teardown);

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith("sbx-a");
  });

  it("reasserts the durable owner child for a reused code workspace", async () => {
    const ctx = makeCtx({
      sandboxId: "code-1",
      agentSandboxIds: { claude: "scratch-1" },
      sandboxIds: new Set(["scratch-1", "code-1"]),
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
    expect(mocks.registerSandbox).toHaveBeenCalledWith(
      "ticket:jira:AWT-1",
      "owner:test",
      "code-1",
    );
    expect(result.kind).toBe("next");
  });

  it.each(runControlErrorCases())(
    "rethrows %s while reasserting a reused workspace owner",
    async (_label, error) => {
      mocks.registerSandbox.mockRejectedValueOnce(error);

      await expect(
        execute(
          makeNode("prepare_workspace"),
          {},
          makeCtx({ sandboxId: "code-1" }),
        ),
      ).rejects.toBe(error);
    },
  );

  it("fails closed when immediate durable sandbox registration throws", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({ status: "continue", selectedRepositories: [repo] });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.registerSandbox.mockRejectedValueOnce(new Error("registry write failed"));

    const ctx = makeCtx({ sandboxId: null, sandboxIds: new Set<string>() });
    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("registry write failed");
    expect(ctx.sandboxId).toBeNull();
    expect([...ctx.sandboxIds]).toEqual([]);
  });

  it("maps a pre-sandbox clarification halt to needs_human_input", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "halt",
      outcome: "needs_clarification",
      message: "unclear",
      questions: ["Which service?"],
    });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result).toEqual({
      kind: "needs_human_input",
      output: { status: "needs_human_input", questions: ["Which service?"] },
      questions: ["Which service?"],
    });
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
  });

  it("maps a pre-sandbox failure halt to kind failed", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "halt",
      outcome: "failed",
      message: "step exploded",
    });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("pre-sandbox: step exploded");
  });

  it("asks for a repository when none is selectable", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({ status: "continue", selectedRepositories: [] });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result).toEqual({
      kind: "needs_human_input",
      output: {
        status: "needs_human_input",
        questions: ["Which repository should this ticket modify?"],
      },
      questions: ["Which repository should this ticket modify?"],
    });
  });

  it("selects the PR repository for pr_trigger entries without the pre-sandbox phase", async () => {
    mocks.blockPrTriggerRepositoriesStep.mockResolvedValue([repo]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const pr = makePrPayload();
    const ctx = makeCtx({
      sandboxId: null,
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_created",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr,
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.blockPrTriggerRepositoriesStep).toHaveBeenCalledWith("run-1", pr);
    expect(mocks.runPreSandboxPhase).not.toHaveBeenCalled();
    expect(result.kind).toBe("next");
  });

  it("provisions the pr_trigger repository as write on its workflow-owned branch", async () => {
    const pr = makePrPayload();
    const triggerRepo: SelectedRepository = {
      ...repo,
      workflowOwnedBranch: {
        branchName: pr.headRef,
        pr: { id: pr.prNumber, url: pr.prUrl, branch: pr.headRef },
      },
    };
    mocks.blockPrTriggerRepositoriesStep.mockResolvedValue([triggerRepo]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(triggerRepo));
    const ctx = makeCtx({
      sandboxId: null,
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_checks_failed",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr,
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("next");
    const [provisionInput] = mocks.provisionMultiRepo.mock.calls[0] as [
      { repositories: Array<Record<string, unknown>> },
    ];
    // The trigger repo checks out its owned PR branch as a write remediation checkout,
    // so the committed fix can publish (a read-only checkout fails read_only_changed).
    expect(provisionInput.repositories[0]).toMatchObject({
      repoPath: "acme/api",
      access: "write",
      workflowOwnedBranch: { branchName: pr.headRef },
    });
  });

  it("provisions a ticket repository without an owned branch as read-only", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({ sandboxId: null });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    const [provisionInput] = mocks.provisionMultiRepo.mock.calls[0] as [
      { access: string; repositories: Array<Record<string, unknown>> },
    ];
    expect(provisionInput.access).toBe("read");
    expect(provisionInput.repositories[0].access).toBeUndefined();
    // Only the approved-scope path pins a research baseline; a plain ticket must not.
    expect(provisionInput.repositories[0].expectedResearchBaseSha).toBeUndefined();
  });

  it("recreates an approved run from the exact still-current repository scope", async () => {
    mocks.listRepositories.mockResolvedValue([
      {
        provider: "github",
        repoPath: "acme/api",
        name: "api",
        owner: "acme",
        defaultBranch: "main",
        description: "",
        webUrl: "https://github.com/acme/api",
        topics: [],
        archived: false,
        private: true,
      },
    ]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({
      sandboxId: null,
      entry: {
        kind: "plan_approved",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        approvedPlan: {
          markdown: "# Plan",
          repositoryScope: {
            repositories: [
              {
                provider: "github",
                repoPath: "acme/api",
                defaultBranch: "main",
                researchBranch: "main",
                researchBaseSha: BASE_SHA,
                access: "write",
                rationale: "ticket mentions api",
              },
            ],
          },
        },
        approval: {
          approvalRequestId: "approval-1",
          approver: "Alice",
          approvedAt: "2026-07-24T00:00:00.000Z",
        },
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("next");
    // The approved research baseline is threaded onto the provisioning input so the
    // manager can reject a branch that moved between approval and clone.
    expect(ctx.selectedRepositories).toEqual([
      { ...repo, expectedResearchBaseSha: BASE_SHA },
    ]);
    const [provisionInput] = mocks.provisionMultiRepo.mock.calls[0] as [
      { repositories: Array<Record<string, unknown>> },
    ];
    expect(provisionInput.repositories[0]).toMatchObject({
      repoPath: "acme/api",
      expectedResearchBaseSha: BASE_SHA,
    });
    expect(mocks.runPreSandboxPhase).not.toHaveBeenCalled();
    expect(mocks.getBranchShaIfExists).toHaveBeenCalledWith("main");
  });

  it("recreates an approved run for an exact definition pin outside the global allowlist", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/other";
    mocks.listRepositories.mockResolvedValue([availableApiRepo()]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    try {
      const ctx = makeCtx({
        sandboxId: null,
        entry: approvedScopeEntry(validApprovedScope),
        repositoryScope: {
          repositories: [{ provider: "github", repoPath: "acme/api" }],
        },
      });

      const result = await execute(makeNode("prepare_workspace"), {}, ctx);

      expect(result.kind).toBe("next");
      expect(ctx.selectedRepositories).toEqual([
        { ...repo, expectedResearchBaseSha: BASE_SHA },
      ]);
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("rejects an approved outside repository without an exact definition pin", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/other";
    mocks.listRepositories.mockResolvedValue([availableApiRepo()]);

    try {
      const result = await execute(
        makeNode("prepare_workspace"),
        {},
        makeCtx({
          sandboxId: null,
          entry: approvedScopeEntry(validApprovedScope),
        }),
      );

      expect(result.kind).toBe("execution_error");
      if (result.kind === "execution_error") {
        expect(result.error.detail).toContain("unavailable or no longer allowed");
      }
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("requires replanning when an approved repository head moved", async () => {
    mocks.listRepositories.mockResolvedValue([
      {
        provider: "github",
        repoPath: "acme/api",
        name: "api",
        owner: "acme",
        defaultBranch: "main",
        description: "",
        webUrl: "https://github.com/acme/api",
        topics: [],
        archived: false,
        private: true,
      },
    ]);
    mocks.getBranchShaIfExists.mockResolvedValue(MOVED_SHA);
    const ctx = makeCtx({
      sandboxId: null,
      entry: {
        kind: "plan_approved",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        approvedPlan: {
          markdown: "# Plan",
          repositoryScope: {
            repositories: [
              {
                provider: "github",
                repoPath: "acme/api",
                defaultBranch: "main",
                researchBranch: "main",
                researchBaseSha: BASE_SHA,
                access: "write",
                rationale: "implementation",
              },
            ],
          },
        },
        approval: {
          approvalRequestId: "approval-1",
          approver: "Alice",
          approvedAt: "2026-07-24T00:00:00.000Z",
        },
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("replan required");
    }
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
  });

  it("requires replanning when an approved repository is missing or no longer allowlisted", async () => {
    mocks.listRepositories.mockResolvedValue([]);
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({
        sandboxId: null,
        entry: {
          kind: "plan_approved",
          subjectKey: "ticket:jira:AWT-1",
          ticketKey: "AWT-1",
          ownerToken: "owner:test",
          definitionId: 1,
          definitionVersion: 1,
          approvedPlan: {
            markdown: "# Plan",
            repositoryScope: {
              repositories: [
                {
                  provider: "github",
                  repoPath: "acme/api",
                  defaultBranch: "main",
                  researchBranch: "main",
                  researchBaseSha: BASE_SHA,
                  access: "write",
                  rationale: "implementation",
                },
              ],
            },
          },
          approval: {
            approvalRequestId: "approval-1",
            approver: "Alice",
            approvedAt: "2026-07-24T00:00:00.000Z",
          },
        },
      }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("unavailable or no longer allowed");
    }
    expect(mocks.getBranchShaIfExists).not.toHaveBeenCalled();
  });

  const approvedScopeEntry = (repositoryScope: unknown) =>
    ({
      kind: "plan_approved",
      subjectKey: "ticket:jira:AWT-1",
      ticketKey: "AWT-1",
      ownerToken: "owner:test",
      definitionId: 1,
      definitionVersion: 1,
      approvedPlan: { markdown: "# Plan", repositoryScope },
      approval: {
        approvalRequestId: "approval-1",
        approver: "Alice",
        approvedAt: "2026-07-24T00:00:00.000Z",
      },
    }) as unknown as ReturnType<typeof makeCtx>["entry"];

  const availableApiRepo = (overrides: Record<string, unknown> = {}) => ({
    provider: "github",
    repoPath: "acme/api",
    name: "api",
    owner: "acme",
    defaultBranch: "main",
    description: "",
    webUrl: "https://github.com/acme/api",
    topics: [],
    archived: false,
    private: true,
    ...overrides,
  });

  const validApprovedScope = {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/api",
        defaultBranch: "main",
        researchBranch: "main",
        researchBaseSha: BASE_SHA,
        access: "write",
        rationale: "implementation",
      },
    ],
  };

  it("requires replanning when the approved scope jsonb is malformed", async () => {
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({
        sandboxId: null,
        entry: approvedScopeEntry({ repositories: "corrupt" }),
      }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("replan required");
    }
    expect(mocks.listRepositories).not.toHaveBeenCalled();
  });

  it("requires replanning when an approved repository is archived", async () => {
    mocks.listRepositories.mockResolvedValue([
      availableApiRepo({ archived: true }),
    ]);
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null, entry: approvedScopeEntry(validApprovedScope) }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("archived");
      expect(result.error.detail).toContain("replan required");
    }
    expect(mocks.getBranchShaIfExists).not.toHaveBeenCalled();
  });

  it("requires replanning when the approved research branch no longer exists", async () => {
    mocks.listRepositories.mockResolvedValue([availableApiRepo()]);
    mocks.getBranchShaIfExists.mockResolvedValue(null);
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null, entry: approvedScopeEntry(validApprovedScope) }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("research branch is unavailable");
      expect(result.error.detail).toContain("replan required");
    }
  });

  it("fails as a transient infrastructure error (not a replan) when the provider is unreachable", async () => {
    mocks.listRepositories.mockResolvedValue([availableApiRepo()]);
    mocks.getBranchShaIfExists.mockRejectedValue(new Error("ECONNRESET"));
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null, entry: approvedScopeEntry(validApprovedScope) }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("transient infrastructure failure");
      expect(result.error.detail).not.toContain("replan required");
    }
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
  });

  it("requires replanning when the pin no longer covers the approved scope", async () => {
    mocks.listRepositories.mockResolvedValue([availableApiRepo()]);
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({
        sandboxId: null,
        entry: approvedScopeEntry(validApprovedScope),
        repositoryScope: {
          repositories: [{ provider: "github", repoPath: "acme/web" }],
        },
      }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain(
        "outside the repositories pinned to this workflow",
      );
      expect(result.error.detail).toContain("replan required");
    }
    expect(mocks.getBranchShaIfExists).not.toHaveBeenCalled();
  });

  it("keeps an approved scope the pin still covers", async () => {
    mocks.listRepositories.mockResolvedValue([availableApiRepo()]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({
        sandboxId: null,
        entry: approvedScopeEntry(validApprovedScope),
        // Stored in the operator's case; the comparison is case-insensitive.
        repositoryScope: {
          repositories: [{ provider: "github", repoPath: "Acme/API" }],
        },
      }),
    );

    expect(result.kind).toBe("next");
  });

  it("passes the definition pin into the pre-sandbox phase and records its narrowing", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
      repositoryScopeNarrowing: { catalogSize: 4, scopedCatalogSize: 1 },
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const repositoryScope = {
      repositories: [{ provider: "github" as const, repoPath: "acme/api" }],
    };
    const ctx = makeCtx({ sandboxId: null, repositoryScope });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.runPreSandboxPhase).toHaveBeenCalledWith({
      ticket: expect.objectContaining({ identifier: "AWT-1" }),
      run: { branchName: "blazebot/awt-1" },
      repositoryScope,
    });
    expect(ctx.repositoryScopeNarrowing).toEqual({
      catalogSize: 4,
      scopedCatalogSize: 1,
    });
  });

  it("records a catalog degradation that failed the run closed", async () => {
    const emit = vi.fn();
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "halt",
      outcome: "failed",
      message: "Repository listing failed for gitlab",
      promptAdditions: { research: [], implementation: [], review: [] },
      repositoryCatalogDegradation: {
        providers: ["gitlab"],
        outcome: "failed_closed",
      },
    });

    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null }),
      {},
      { observations: { emit } },
    );

    expect(emit).toHaveBeenCalledWith({
      kind: "metadata",
      value: {
        repositoryWorkflow: {
          event: "catalog_degraded",
          providers: ["gitlab"],
          outcome: "failed_closed",
        },
      },
    });
    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("Repository listing failed for gitlab");
    }
  });

  it("prepares a review-only human PR without creating a workflow branch", async () => {
    const pr = makePrPayload();
    const reviewRepo: SelectedRepository = {
      ...repo,
      workflowOwnedBranch: {
        branchName: pr.headRef,
        pr: { id: pr.prNumber, url: pr.prUrl, branch: pr.headRef },
      },
    };
    mocks.blockPrTriggerRepositoriesStep.mockResolvedValue([reviewRepo]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(reviewRepo));
    const ctx = makeCtx({
      sandboxId: null,
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        subjectKey: "pr:github:acme/api#42",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "any",
        pr,
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.blockPrTriggerRepositoriesStep).toHaveBeenCalledWith(
      "run-1",
      pr,
    );
    expect(result.kind).toBe("next");
  });

  it("maps provisioning errors to kind failed", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.provisionMultiRepo.mockRejectedValue(new Error("no capacity"));

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("no capacity");
  });

  it.each(runControlErrorCases())("rethrows %s from provisioning", async (_label, error) => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.provisionMultiRepo.mockRejectedValue(error);

    await expect(
      execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null })),
    ).rejects.toBe(error);
  });
});

describe("maybePromoteTicketWorkspaceWrites", () => {
  const readManifest = (): WorkspaceManifestV2 => ({
    version: 2,
    repositories: [
      {
        provider: "github",
        repoPath: "acme/api",
        slug: "acme__api",
        localPath: "/vercel/sandbox",
        defaultBranch: "main",
        branchName: "main",
        selectedRationale: "ticket mentions api",
        access: "read",
        researchBaseSha: "base-sha",
      },
    ],
  });
  const writeManifest = (): WorkspaceManifestV2 => ({
    version: 2,
    repositories: [
      {
        provider: "github",
        repoPath: "acme/api",
        slug: "acme__api",
        localPath: "/vercel/sandbox",
        defaultBranch: "main",
        branchName: "blazebot/awt-1",
        selectedRationale: "ticket mentions api",
        access: "write",
        expectedRemoteSha: "base-sha",
        preAgentSha: "base-sha",
        workflowOwnedBranch: { branchName: "blazebot/awt-1" },
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
  });

  it("promotes every selected repository for a ticket graph without a planning node", async () => {
    const promoted = writeManifest();
    mocks.promoteRepositoryWriteScopeStep.mockResolvedValue(promoted);
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      selectedRepositories: [repo],
      definitionNodes: [makeNode("implementation_agent", {}, "impl-1")],
      researchWriteRepositories: [],
    });

    const result = await maybePromoteTicketWorkspaceWrites(ctx);

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "blazebot/awt-1",
        ticketKey: "AWT-1",
        writeRepositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            rationale: "ticket mentions api",
          },
        ],
      }),
    );
    expect(ctx.workspaceManifest).toBe(promoted);
    expect(ctx.researchWriteRepositories).toEqual([
      { provider: "github", repoPath: "acme/api", rationale: "ticket mentions api" },
    ]);
  });

  it("does not promote when the definition contains a planning node", async () => {
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      selectedRepositories: [repo],
      definitionNodes: [
        makeNode("planning_agent", {}, "plan-1"),
        makeNode("implementation_agent", {}, "impl-1"),
      ],
      researchWriteRepositories: [],
    });

    const result = await maybePromoteTicketWorkspaceWrites(ctx);

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).not.toHaveBeenCalled();
    expect(ctx.workspaceManifest?.version).toBe(2);
    expect(
      (ctx.workspaceManifest as WorkspaceManifestV2).repositories[0].access,
    ).toBe("read");
  });

  it("does not promote when a completed research write set already exists", async () => {
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      selectedRepositories: [repo],
      definitionNodes: [makeNode("implementation_agent", {}, "impl-1")],
      researchWriteRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "planner" },
      ],
    });

    const result = await maybePromoteTicketWorkspaceWrites(ctx);

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).not.toHaveBeenCalled();
  });

  it("does not promote when the workspace already has a write repository", async () => {
    const ctx = makeCtx({
      workspaceManifest: writeManifest(),
      selectedRepositories: [repo],
      definitionNodes: [makeNode("implementation_agent", {}, "impl-1")],
      researchWriteRepositories: [],
    });

    const result = await maybePromoteTicketWorkspaceWrites(ctx);

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).not.toHaveBeenCalled();
  });

  it("promotes every selected repository for a webhook_trigger entry", async () => {
    const promoted = writeManifest();
    mocks.promoteRepositoryWriteScopeStep.mockResolvedValue(promoted);
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      selectedRepositories: [repo],
      definitionNodes: [makeNode("implementation_agent", {}, "impl-1")],
      researchWriteRepositories: [],
      entry: {
        kind: "webhook_trigger",
        endpointId: "wh_a1b2c3d4e5f6a7b8c9d0e1f2",
        definitionId: 9,
        definitionVersion: 3,
        nodeId: "webhook-support",
        deliveryId: "delivery-1",
        subjectKey: "webhook:wh_a1b2c3d4e5f6a7b8c9d0e1f2:ticket-77",
        ownerToken: "owner:test",
        entry: {
          subject: "Printer is on fire",
          description: "Smoke after the firmware update.",
          requester: "customer@acme.test",
          priority: "urgent",
          payload: { ticket: { id: 77 } },
        },
      },
      ticket: {
        id: "webhook-d0e1f2-9a8b7c6d",
        identifier: "webhook-d0e1f2-9a8b7c6d",
        title: "Printer is on fire",
        description: "Smoke after the firmware update.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "",
        attachments: [],
      },
    });

    const result = await maybePromoteTicketWorkspaceWrites(ctx);

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).toHaveBeenCalledWith(
      expect.objectContaining({
        // No correlated ticket, so promotion falls back to the git-safe
        // synthesized identifier rather than a colon-laden subject key.
        ticketKey: "webhook-d0e1f2-9a8b7c6d",
        writeRepositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            rationale: "ticket mentions api",
          },
        ],
      }),
    );
    expect(ctx.workspaceManifest).toBe(promoted);
  });

  // A scheduled run owns a fresh branch off its synthesized identifier and no
  // other path ever promotes it, so leaving this kind out means the run can never
  // open a pull request, silently.
  it("promotes every selected repository for a schedule entry", async () => {
    const promoted = writeManifest();
    mocks.promoteRepositoryWriteScopeStep.mockResolvedValue(promoted);
    const identifier = "schedule-sch_a1b2c3d4e5f6a7b8c9d0e1f2-20260805T1400";
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      selectedRepositories: [repo],
      definitionNodes: [makeNode("implementation_agent", {}, "impl-1")],
      researchWriteRepositories: [],
      entry: {
        kind: "schedule",
        scheduleId: "sch_a1b2c3d4e5f6a7b8c9d0e1f2",
        definitionId: 9,
        definitionVersion: 3,
        nodeId: "schedule-nightly",
        subjectKey: "schedule:sch_a1b2c3d4e5f6a7b8c9d0e1f2",
        ownerToken: "owner:test",
        scheduledFor: "2026-08-05T14:00:00.000Z",
        taskTitle: "Sweep the backlog",
        taskDescription: "Look for stale tickets.",
      },
      ticket: {
        id: identifier,
        identifier,
        title: "Sweep the backlog",
        description: "Look for stale tickets.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "",
        attachments: [],
      },
    });

    const result = await maybePromoteTicketWorkspaceWrites(ctx);

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).toHaveBeenCalledWith(
      expect.objectContaining({
        // No correlated ticket, so promotion falls back to the git-safe
        // synthesized identifier rather than a colon-laden subject key.
        ticketKey: identifier,
        writeRepositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            rationale: "ticket mentions api",
          },
        ],
      }),
    );
    expect(ctx.workspaceManifest).toBe(promoted);
  });

  it("does not promote for a pr_trigger entry (Part 1 already provisions its owned branch write)", async () => {
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      selectedRepositories: [repo],
      definitionNodes: [makeNode("fix_agent", {}, "fix-1")],
      researchWriteRepositories: [],
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        subjectKey: "pr:github:acme/api#7",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr: makePrPayload(),
      },
    });

    const result = await maybePromoteTicketWorkspaceWrites(ctx);

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).not.toHaveBeenCalled();
  });
});

describe("maybePromoteGenericAgentWorkspace", () => {
  const readManifest = (): WorkspaceManifestV2 => ({
    version: 2,
    repositories: [
      {
        provider: "github",
        repoPath: "acme/api",
        slug: "acme__api",
        localPath: "/vercel/sandbox",
        defaultBranch: "main",
        branchName: "main",
        selectedRationale: "ticket mentions api",
        access: "read",
        researchBaseSha: "base-sha",
      },
    ],
  });
  const writeManifest = (): WorkspaceManifestV2 => ({
    version: 2,
    repositories: [
      {
        ...readManifest().repositories[0],
        branchName: "blazebot/awt-1",
        access: "write",
        expectedRemoteSha: "base-sha",
        preAgentSha: "base-sha",
        workflowOwnedBranch: { branchName: "blazebot/awt-1" },
      },
    ],
  });
  const genericNode = (workspaceMode: string) =>
    makeNode("generic_agent", { workspaceMode }, "gen-1");
  const ticketWithoutPlanningCtx = () =>
    makeCtx({
      sandboxId: "sbx-1",
      workspaceManifest: readManifest(),
      selectedRepositories: [repo],
      definitionNodes: [genericNode("read_write")],
      researchWriteRepositories: [],
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
  });

  it("promotes a workspace-enabled generic_agent on a ticket graph without planning", async () => {
    mocks.promoteRepositoryWriteScopeStep.mockResolvedValue(writeManifest());
    const ctx = ticketWithoutPlanningCtx();

    const result = await maybePromoteGenericAgentWorkspace(
      ctx,
      genericNode("read_write"),
    );

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).toHaveBeenCalledWith(
      expect.objectContaining({
        writeRepositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            rationale: "ticket mentions api",
          },
        ],
      }),
    );
    expect(
      (ctx.workspaceManifest as WorkspaceManifestV2).repositories[0].access,
    ).toBe("write");
  });

  it("does not promote a workspace-enabled generic_agent when a planning node exists", async () => {
    const ctx = ticketWithoutPlanningCtx();
    ctx.definitionNodes = [
      makeNode("planning_agent", {}, "plan-1"),
      genericNode("read_write"),
    ];

    const result = await maybePromoteGenericAgentWorkspace(
      ctx,
      genericNode("read_write"),
    );

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).not.toHaveBeenCalled();
    expect(
      (ctx.workspaceManifest as WorkspaceManifestV2).repositories[0].access,
    ).toBe("read");
  });

  it("does not promote a workspace-free generic_agent", async () => {
    const ctx = ticketWithoutPlanningCtx();

    const result = await maybePromoteGenericAgentWorkspace(
      ctx,
      genericNode("none"),
    );

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).not.toHaveBeenCalled();
  });

  it("does not promote before a workspace is attached", async () => {
    const ctx = ticketWithoutPlanningCtx();
    ctx.sandboxId = null;

    const result = await maybePromoteGenericAgentWorkspace(
      ctx,
      genericNode("read_write"),
    );

    expect(result).toBeNull();
    expect(mocks.promoteRepositoryWriteScopeStep).not.toHaveBeenCalled();
  });
});

describe("researchDeclaredNoWritesGuard", () => {
  const readManifest = (): WorkspaceManifestV2 => ({
    version: 2,
    repositories: [
      {
        provider: "github",
        repoPath: "acme/api",
        slug: "acme__api",
        localPath: "/vercel/sandbox",
        defaultBranch: "main",
        branchName: "main",
        selectedRationale: "ticket mentions api",
        access: "read",
        researchBaseSha: "base-sha",
      },
    ],
  });
  const writeManifest = (): WorkspaceManifestV2 => ({
    version: 2,
    repositories: [
      {
        ...readManifest().repositories[0],
        branchName: "blazebot/awt-1",
        access: "write",
        expectedRemoteSha: "base-sha",
        preAgentSha: "base-sha",
        workflowOwnedBranch: { branchName: "blazebot/awt-1" },
      },
    ],
  });

  // IM-1: research completed with no write set on a planning graph. The workspace
  // stays all-read, so implementation must fail loud and early with replan-required
  // instead of committing on a read-only checkout and dying at publication.
  it("fails loud when a planning graph declared no write set on an all-read workspace", () => {
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      definitionNodes: [
        makeNode("planning_agent", {}, "plan-1"),
        makeNode("implementation_agent", {}, "impl-1"),
      ],
      researchWriteRepositories: [],
    });

    const result = researchDeclaredNoWritesGuard(ctx);

    expect(result?.kind).toBe("execution_error");
    if (result?.kind === "execution_error") {
      expect(result.error.detail).toContain("replan required");
      expect(result.error.detail).toContain("nothing to implement");
    }
  });

  it("passes when research declared a write set", () => {
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      definitionNodes: [
        makeNode("planning_agent", {}, "plan-1"),
        makeNode("implementation_agent", {}, "impl-1"),
      ],
      researchWriteRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "planner" },
      ],
    });

    expect(researchDeclaredNoWritesGuard(ctx)).toBeNull();
  });

  it("passes when the workspace already carries a write repository", () => {
    const ctx = makeCtx({
      workspaceManifest: writeManifest(),
      definitionNodes: [
        makeNode("planning_agent", {}, "plan-1"),
        makeNode("implementation_agent", {}, "impl-1"),
      ],
      researchWriteRepositories: [],
    });

    expect(researchDeclaredNoWritesGuard(ctx)).toBeNull();
  });

  it("does not apply to a ticket graph without a planning node", () => {
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      definitionNodes: [makeNode("implementation_agent", {}, "impl-1")],
      researchWriteRepositories: [],
    });

    expect(researchDeclaredNoWritesGuard(ctx)).toBeNull();
  });

  it("fails loud for a webhook_trigger planning graph that declared no write set", () => {
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      definitionNodes: [
        makeNode("planning_agent", {}, "plan-1"),
        makeNode("implementation_agent", {}, "impl-1"),
      ],
      researchWriteRepositories: [],
      entry: {
        kind: "webhook_trigger",
        endpointId: "wh_a1b2c3d4e5f6a7b8c9d0e1f2",
        definitionId: 9,
        definitionVersion: 3,
        nodeId: "webhook-support",
        deliveryId: "delivery-1",
        subjectKey: "webhook:wh_a1b2c3d4e5f6a7b8c9d0e1f2:ticket-77",
        ownerToken: "owner:test",
        entry: {
          subject: "Printer is on fire",
          description: "Smoke after the firmware update.",
          requester: "customer@acme.test",
          priority: "urgent",
          payload: { ticket: { id: 77 } },
        },
      },
    });

    const result = researchDeclaredNoWritesGuard(ctx);

    expect(result?.kind).toBe("execution_error");
    if (result?.kind === "execution_error") {
      expect(result.error.detail).toContain("replan required");
      expect(result.error.detail).toContain("nothing to implement");
    }
  });

  it("does not apply to a plan_approved run (it promotes from the approved scope)", () => {
    const ctx = makeCtx({
      workspaceManifest: readManifest(),
      definitionNodes: [
        makeNode("planning_agent", {}, "plan-1"),
        makeNode("implementation_agent", {}, "impl-1"),
      ],
      researchWriteRepositories: [],
      entry: {
        kind: "plan_approved",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        approvedPlan: { markdown: "# Plan" },
        approval: {
          approvalRequestId: "approval-1",
          approver: "Alice",
          approvedAt: "2026-07-24T00:00:00.000Z",
        },
      },
    });

    expect(researchDeclaredNoWritesGuard(ctx)).toBeNull();
  });
});
