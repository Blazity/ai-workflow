import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_API_KEY: "codex-key",
    JOB_TIMEOUT_MS: 1000,
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
  postComment: vi.fn(),
  findCommentByMarker: vi.fn(),
  fetchTicket: vi.fn(),
  trackerHasMarkerLookup: true,
  assertConnectedActiveRunOwner: vi.fn(),
}));

vi.mock("../../../infra/vcs-config.js", () => ({
  env: mocks.env,
  getConfiguredVcsProviders: () => [{ kind: "github" }],
}));
vi.mock("../../steps/pre-sandbox-runner.js", () => ({
  runPreSandboxPhase: mocks.runPreSandboxPhase,
}));
vi.mock("../fetch-pr-context/execute.js", () => ({
  blockFetchPrContextsStep: mocks.blockFetchPrContextsStep,
  blockPrTriggerRepositoriesStep: mocks.blockPrTriggerRepositoriesStep,
  blockPrTriggerRepositoriesWithSiblingsStep: mocks.blockPrTriggerRepositoriesStep,
}));
vi.mock("../../steps/repository-promotion.js", () => ({
  promoteRepositoryWriteScopeStep: mocks.promoteRepositoryWriteScopeStep,
}));
vi.mock("../../steps/memory-steps.js", () => ({
  hydrateWorkspaceMemoryStep: mocks.hydrateWorkspaceMemoryStep,
}));
vi.mock("../../steps/repo-seed-steps.js", () => ({
  seedRepoMemoryStep: mocks.seedRepoMemoryStep,
}));
vi.mock("../../steps/repo-memory-steps.js", () => ({
  captureDefaultBranchFilesStep: mocks.captureDefaultBranchFilesStep,
}));
vi.mock("../../../sandbox/manager.js", () => ({
  SandboxManager: vi.fn((config: unknown) => {
    mocks.sandboxManagerCtor(config);
    return { provisionMultiRepo: mocks.provisionMultiRepo };
  }),
}));
// The two engine calls are replaced; setupFailureMessage is pure composition
// over what the mocked call returned, and the block is asserted on the sentence
// it actually records.
vi.mock("../pre-pr-checks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pre-pr-checks.js")>()),
  resolveChecksProvisioningStep: mocks.resolveChecksProvisioningStep,
  runRepositorySetup: mocks.runRepositorySetup,
}));
vi.mock("../../../sandbox/agents/index.js", () => ({
  createAgentAdapter: mocks.createAgentAdapter,
}));
// Every provider-backed call this block makes: an adapter for one repository,
// the sandbox credentials, and the listing the approved scope is checked
// against. The pin predicate beside them is pure, so its module stays real.
vi.mock("../../../engine/support/vcs-runtime.js", () => ({
  buildSandboxProviderConfigs: mocks.buildSandboxProviderConfigs,
  createRepositoryVCS: () => ({
    getBranchSha: mocks.getBranchSha,
    getBranchShaIfExists: mocks.getBranchShaIfExists,
  }),
  listVcsRepositories: async () => ({
    repositories: await mocks.listRepositories(),
    failures: [],
  }),
}));
vi.mock("../../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../../db/repositories/runs.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
  listConnectedWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
}));
vi.mock("../../../engine/support/adapters.js", () => ({
  createAdapters: () => ({
    runRegistry: { registerSandbox: mocks.registerSandbox },
    issueTrackerResolution: {
      ok: true,
      adapter: {
        postComment: mocks.postComment,
        fetchTicket: mocks.fetchTicket,
        ...(mocks.trackerHasMarkerLookup
          ? { findCommentByMarker: mocks.findCommentByMarker }
          : {}),
      },
    },
  }),
}));
vi.mock("../../../db/repositories/active-runs.js", () => ({
  assertConnectedActiveRunOwner: mocks.assertConnectedActiveRunOwner,
}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../../../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));

import type { SelectedRepository } from "../../../adapters/vcs/repository-directory.js";
import {
  ensureWorkspace,
  execute,
  maybePromoteGenericAgentWorkspace,
  maybePromoteTicketWorkspaceWrites,
  researchDeclaredNoWritesGuard,
  sandboxLifetimeMs,
} from "./execute.js";
import { manifest as prepareWorkspaceManifest } from "./manifest.js";
import { repositoryNotEnabledMessage } from "../../support/repository-access.js";
// The three places a repository question ends up: the ticket comment a person
// reads, the prompts the agent is given, and the ticket's memory file.
import { formatClarificationQuestionsComment } from "../../support/clarification-comment-format.js";
import { renderHumanDecisionsSection } from "../../support/human-decisions-memory.js";
import { assembleResearchPlanContext } from "../../../sandbox/context.js";
import type { WorkspaceManifestV2 } from "../../../sandbox/repo-workspace.js";
import { teardownSandboxes } from "../../steps/sandbox-poll-agent.js";
import { checksCeilingExceededError } from "../../helpers/run-budget.js";
import {
  makeCtx as makeBaseCtx,
  makeInvocation,
  makeNode,
  makePrPayload,
  makeRunSettings,
  runControlErrorCases,
} from "../support/test-support.js";

/**
 * The run's ENABLE_REPO_MEMORY, as this block now reads it: off the run context
 * that the run-start step froze, never from the environment. Mutated per test,
 * because most cases here are about the memory steps and the registry default
 * for the key is off.
 */
let memoryEnabled = true;

/** `makeCtx` with this file's memory flag already on the run's settings. A case
 *  that passes its own `settings` decides for itself. */
function makeCtx(
  overrides: Parameters<typeof makeBaseCtx>[0] = {},
): ReturnType<typeof makeBaseCtx> {
  return makeBaseCtx({
    settings: makeRunSettings({ ENABLE_REPO_MEMORY: memoryEnabled }),
    ...overrides,
  });
}

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

function restoreAgentAdapterMock(): void {
  mocks.createAgentAdapter.mockImplementation((kind: string) => ({
    kind,
    cliSpec: { displayName: kind, binName: kind },
    install: mocks.agentInstall,
    configure: mocks.agentConfigure,
  }));
}

// vi.clearAllMocks() clears calls but keeps implementations, and mocks.env is a
// plain object it never touches at all. Both leak across tests: a memory step
// left rejecting with a run-control error would now fail every later test.
beforeEach(() => {
  memoryEnabled = true;
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
    expect(prepareWorkspaceManifest.paramsSchema.safeParse({}).success).toBe(true);
    expect(prepareWorkspaceManifest.paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

/** A definition that reaches the repository scripts engine, which is the only
 *  kind that provisions setup. */
const SCRIPT_NODES = [
  { id: "checks", type: "run_pre_pr_checks", name: "Run pre-PR checks", params: {} },
] as unknown as NonNullable<Parameters<typeof makeCtx>[0]>["definitionNodes"];

const SETUP_BOUNDARY_ERROR_CASES = [
  {
    label: "checks ceiling",
    create: () =>
      checksCeilingExceededError(900_000, "Setup batch for github:acme/api"),
    expected: {
      name: "ChecksCeilingExceededError",
      message:
        "The repository checks did not finish within the 15 minute checks ceiling. " +
        "Raise the checks ceiling on the Repositories page (open the repository, " +
      "Scripts tab, checks ceiling), or split the run. " +
        "(checks_ceiling_exceeded: Setup batch for github:acme/api reached the 15 minute checks ceiling)",
    },
  },
  {
    label: "ordinary abort",
    create: () => new DOMException("sandbox request aborted", "AbortError"),
    expected: { name: "AbortError", message: "sandbox request aborted" },
  },
  {
    label: "invocation cancellation",
    create: () =>
      Object.assign(new Error("invocation superseded"), {
        name: "V2InvocationCancelledError",
      }),
    expected: {
      name: "V2InvocationCancelledError",
      message: "invocation superseded",
    },
  },
] as const;

describe("prepare_workspace execute", () => {
  beforeEach(() => {
    // Setup failures and registration failures must not survive into the next case.
    vi.resetAllMocks();
    restoreAgentAdapterMock();
    mocks.captureDefaultBranchFilesStep.mockResolvedValue({});
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

  /**
   * The silent case: the selection refused a repository and the run did NOT
   * halt, so nothing in the halt text ever reaches anybody. Both fields have to
   * land on the run context here, or the report the finished run builds has
   * nothing to say and the person reads a green run that shipped half the work.
   */
  it("carries what the selection left out, and what to do about it, onto the run", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
      workScopeLeftOut: [
        {
          repositoryKey: "github:acme/web",
          reason: "github:acme/web was excluded on this work, so the run started without it.",
        },
      ],
      workScopeRecoveryNotes: ["Excluding a repository is not final."],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({ sandboxId: null });

    const result = await ensureWorkspace(ctx, undefined, {});

    expect(result.kind).toBe("next");
    expect(ctx.workScopeLeftOut).toEqual([
      {
        repositoryKey: "github:acme/web",
        reason: "github:acme/web was excluded on this work, so the run started without it.",
      },
    ]);
    expect(ctx.workScopeRecoveryNotes).toEqual(["Excluding a repository is not final."]);
  });

  /**
   * A repository nobody chose, cloned with write access, is the third of the
   * silent failures this feature was written against: the run could commit to
   * a repository whose only claim on the ticket is an edge somebody drew in a
   * catalog. The guarantee is only real where it is observable, so this asserts
   * the WORKSPACE INPUT, which is what provisioning actually clones.
   */
  it("blames the settings it could not read, not the sandbox, and creates none", async () => {
    // The provider credentials are read before any sandbox exists. When that
    // read failed, the person was told the workspace environment could not
    // complete the block, and went looking at Vercel Sandbox.
    const { IntegrationSettingsUnreadableError } = await import(
      "../../../services/integrations/usable.js"
    );
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.buildSandboxProviderConfigs.mockRejectedValue(
      new IntegrationSettingsUnreadableError(
        "so no sandbox was given version control credentials",
        "connection terminated unexpectedly",
      ),
    );

    const result = await ensureWorkspace(makeCtx({ sandboxId: null }), undefined, {});

    if (result.kind !== "execution_error") throw new Error("expected a refusal");
    expect(result.error.category).toBe("engine");
    expect(result.error.message).toContain("could not read the deployment's integration settings");
    expect(JSON.stringify(result.error)).not.toContain("connection terminated");
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
  });

  // A person closed the pull request, deleted its branch and moved the ticket
  // back to start over. The fetch step found the branch gone and handed the
  // repository back without its ownership; the run must clone the default
  // branch and tell the person on the ticket why it is not continuing.
  it("starts a ticket re-run from the default branch and says why on the ticket", async () => {
    const owned: SelectedRepository = {
      ...repo,
      workflowOwnedBranch: {
        branchName: "ai-workflow/awp-271",
        pr: { id: 18, url: "https://github.com/acme/api/pull/18", branch: "ai-workflow/awp-271" },
      },
    };
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [owned],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue([
      {
        repository: repo,
        prComments: [],
        checkResults: [],
        hasConflicts: false,
        previousBranchGone: {
          branchName: "ai-workflow/awp-271",
          pr: { id: 18, url: "https://github.com/acme/api/pull/18" },
        },
      },
    ]);
    mocks.postComment.mockResolvedValue(null);
    const ctx = makeCtx({ sandboxId: null });

    const result = await ensureWorkspace(ctx, undefined, {});

    expect(result.kind).toBe("next");
    expect(mocks.blockFetchPrContextsStep.mock.calls[0]?.[2]).toMatchObject({
      dropMissingOwnedBranches: true,
    });
    const provisioned = mocks.provisionMultiRepo.mock.calls[0]?.[0] as {
      repositories: Array<Record<string, unknown>>;
    };
    expect(provisioned.repositories[0]?.workflowOwnedBranch).toBeUndefined();
    expect(provisioned.repositories[0]?.access).toBeUndefined();
    expect(mocks.postComment).toHaveBeenCalledTimes(1);
    const [ticketId, body] = mocks.postComment.mock.calls[0] as [string, string];
    expect(ticketId).toBe(ctx.ticket.identifier);
    expect(body).toContain("ai-workflow/awp-271 no longer exists");
    expect(body).toContain("starts from main");
    expect(body).toContain("Pull request #18");
    expect(body.split("\n")).toContain("Fresh start key: github:acme/api ai-workflow/awp-271 pr=18");
    if (result.kind !== "next") throw new Error("expected next");
    expect(result.output).toMatchObject({
      freshStarts: [
        {
          repository: "github:acme/api",
          deletedBranch: "ai-workflow/awp-271",
          startedFrom: "main",
          previousPullRequest: 18,
        },
      ],
    });
  });

  describe("the fresh start notice, once per ticket and deleted branch", () => {
    /** The ticket as the tracker holds it: every comment posted so far. */
    let ticketComments: string[];

    beforeEach(() => {
      ticketComments = [];
      mocks.trackerHasMarkerLookup = true;
      mocks.postComment.mockImplementation(async (_ticket: string, body: string) => {
        ticketComments.push(body);
        return null;
      });
      // What the Jira adapter does: an exact line match over every comment.
      mocks.findCommentByMarker.mockImplementation(async (_ticket: string, marker: string) =>
        ticketComments.some((body) => body.split("\n").some((line) => line.trim() === marker))
          ? "https://jira/browse/AWT-1?focusedCommentId=1"
          : null,
      );
      mocks.fetchTicket.mockImplementation(async () => ({
        comments: ticketComments.map((body) => ({ body })),
      }));
    });

    afterEach(() => {
      mocks.trackerHasMarkerLookup = true;
    });

    function branchGoneRun(prId: number | null) {
      mocks.runPreSandboxPhase.mockResolvedValue({
        status: "continue",
        promptAdditions: { research: [], implementation: [], review: [] },
        selectedRepositories: [repo],
      });
      mocks.blockFetchPrContextsStep.mockResolvedValue([
        {
          repository: repo,
          prComments: [],
          checkResults: [],
          hasConflicts: false,
          previousBranchGone: {
            branchName: "ai-workflow/awp-271",
            ...(prId === null
              ? {}
              : { pr: { id: prId, url: `https://github.com/acme/api/pull/${prId}` } }),
          },
        },
      ]);
      return ensureWorkspace(makeCtx({ sandboxId: null }), undefined, {});
    }

    // Definition 14: the planning run finds the branch gone, then the
    // implementation run after plan approval finds the same branch gone again.
    it("tells the person once across the planning and the implementation run", async () => {
      expect((await branchGoneRun(18)).kind).toBe("next");
      expect((await branchGoneRun(18)).kind).toBe("next");

      expect(ticketComments).toHaveLength(1);
      expect(ticketComments[0]).toContain("ai-workflow/awp-271 no longer exists");
    });

    it("gives the same once-only answer on a tracker that can only read the ticket", async () => {
      mocks.trackerHasMarkerLookup = false;

      await branchGoneRun(18);
      await branchGoneRun(18);

      expect(ticketComments).toHaveLength(1);
    });

    it("tells the person again when a later pull request on that branch went the same way", async () => {
      await branchGoneRun(18);
      await branchGoneRun(19);

      expect(ticketComments).toHaveLength(2);
      expect(ticketComments[1]).toContain("Pull request #19");
    });

    it("still tells the person when the tracker cannot say what the ticket carries", async () => {
      mocks.findCommentByMarker.mockRejectedValue(new Error("Jira 503"));

      await branchGoneRun(18);

      expect(ticketComments).toHaveLength(1);
    });
  });

  it("posts nothing on the ticket when the earlier branch still exists", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const result = await ensureWorkspace(makeCtx({ sandboxId: null }), undefined, {});

    expect(result.kind).toBe("next");
    expect(mocks.postComment).not.toHaveBeenCalled();
    if (result.kind !== "next") throw new Error("expected next");
    expect(result.output).not.toHaveProperty("freshStarts");
  });

  it("keeps a pull request run on its branch: no branch probe is asked for", async () => {
    mocks.blockPrTriggerRepositoriesStep.mockResolvedValue([repo]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({
      sandboxId: null,
      entry: { ...makeCtx().entry, kind: "pr_trigger", pr: makePrPayload() } as never,
    });

    await ensureWorkspace(ctx, undefined, {});

    expect(mocks.blockPrTriggerRepositoriesStep).toHaveBeenCalledTimes(1);
    expect(mocks.blockFetchPrContextsStep).toHaveBeenCalledTimes(1);
    expect(mocks.blockFetchPrContextsStep.mock.calls[0]?.[2]).not.toHaveProperty(
      "dropMissingOwnedBranches",
    );
  });

  it("clones a related repository read only", async () => {
    const web: SelectedRepository = {
      provider: "github",
      repoPath: "acme/web",
      defaultBranch: "main",
      selectedRationale: "Related to github:acme/api, which this work names.",
    };
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo, web],
      repositoryMap: {
        repositories: [],
        relatedAttachments: [
          {
            repositoryKey: "github:acme/web",
            viaRepositoryKey: "github:acme/api",
            relationship: "backend_for",
          },
        ],
      },
    });
    // Whatever the selection hands on, mirrored back the way the real step
    // does, so the assertion below is about the run's rule and not the mock.
    mocks.blockFetchPrContextsStep.mockImplementation(
      async (repositories: SelectedRepository[]) =>
        repositories.map((repository) => ({
          repository,
          prComments: [],
          checkResults: [],
          hasConflicts: false,
        })),
    );
    const ctx = makeCtx({ sandboxId: null });

    await ensureWorkspace(ctx, undefined, {});

    expect(mocks.provisionMultiRepo).toHaveBeenCalledTimes(1);
    const provisioned = (
      mocks.provisionMultiRepo.mock.calls[0]![0] as {
        repositories: Array<{ repoPath: string; access?: string }>;
      }
    ).repositories;
    expect(provisioned.find((entry) => entry.repoPath === "acme/web")?.access).toBe("read");
    // And the repository the ticket itself names keeps the default, which is
    // write: this rule narrows one repository, not the workspace.
    expect(provisioned.find((entry) => entry.repoPath === "acme/api")?.access).toBeUndefined();
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
    // Nothing says what was stored, so teardown must ask before it writes.
    expect(ctx.workspaceNotebookRecalled).toBe(false);
  });

  it("tells teardown whether the agent started from the stored notebook", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.hydrateWorkspaceMemoryStep.mockResolvedValue({
      source: "none",
      trackedInRepo: false,
      written: false,
      unavailable: "Built-in memory could not answer",
      recalled: false,
    });
    const ctx = makeCtx({ sandboxId: null });

    await ensureWorkspace(ctx, undefined, {});

    expect(ctx.workspaceNotebookRecalled).toBe(false);
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
    memoryEnabled = false;
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

  // THE ANSWER IS AN ANSWER, AND NEVER PART OF THE TICKET.
  //
  // It used to travel as both: a synthetic comment appended to the ticket the
  // selection reads, beside the field that says these words are a reply. The
  // comment put a person's words in front of the path scanner, which knows
  // nothing about who said what and matches any path it sees, so a reply the
  // careful reader had refused, "not github:acme/billing", still handed billing
  // to the run and wrote it into the record as chosen by the ticket.
  it("passes the clarification answer back as an answer and not as ticket text", async () => {
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

    const input = mocks.runPreSandboxPhase.mock.calls[0]![0];
    expect(input.clarification).toEqual({
      answer: "Use github:acme/api",
      resolves: "repository_selection",
    });
    expect(JSON.stringify(input.ticket.comments)).not.toContain("Use github:acme/api");
  });

  it("keeps an answer the record declined to attribute out of the selection scan and the routing memory", async () => {
    // Two executions of the one block, which is what really happens: the first
    // raises a question the record is told about, the second comes back with
    // the answer, carrying the record's verdict on it.
    mocks.runPreSandboxPhase.mockResolvedValueOnce({
      status: "halt",
      outcome: "needs_clarification",
      message: "which repository",
      questions: ["Does this ticket also touch github:acme/api?"],
      workScopeAsk: {
        subjectKey: "ticket:jira:AWT-1",
        askedRepositories: [
          { repositoryKey: "github:acme/api", askedBecause: "selection" },
        ],
      },
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const ctx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: { subjectKey: "ticket:jira:AWT-1", version: 1, entries: [] },
        selectionAnswered: false,
      },
    });
    const asked = await (execute as any)(makeNode("prepare_workspace"), {}, ctx);
    expect(asked.kind).toBe("needs_human_input");

    // The record as the answer left it, which is what the run re-reads before
    // the block runs again. It read these words against the catalog, the policy
    // and the question actually asked, and declined to attribute them: two
    // people wrote them together, so nobody can be credited with the decision
    // they would add up to. That verdict is the fact, and the untouched entries
    // below could equally mean an answer it read and found nothing in.
    ctx.workScope = {
      subjectKey: "ticket:jira:AWT-1",
      scope: { subjectKey: "ticket:jira:AWT-1", version: 1, entries: [] },
      selectionAnswered: false,
      answerAttributed: false,
    };

    await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      ctx,
      {},
      { clarificationAnswer: "Jane: use github:acme/api\n\nBob: agreed" },
    );

    const input = mocks.runPreSandboxPhase.mock.calls[1]![0];
    // Neither route in: the text scan below would read a repository key out of
    // those same words and credit it to whoever this run names, which is the
    // decision the record refused to make.
    expect(
      input.ticket.comments.some((c: { author: string }) => c.author === "Human clarification"),
    ).toBe(false);
    expect(input.clarification).toBeUndefined();
  });

  it("withholds without a verdict when only a person's earlier edit sits in the record", async () => {
    // The older reading, which is all a run replaying a result written before
    // the verdict field existed has. The door the Repositories page opened: an
    // edit writes a person-origin selected entry and answers no question at
    // all. A gate reading "does the record hold a person's selection" would see
    // that edit, call this muddled answer accepted, and hand the prose to the
    // text scan. What this answer CHANGED is the only thing that can say, and
    // it changed nothing.
    mocks.runPreSandboxPhase.mockResolvedValueOnce({
      status: "halt",
      outcome: "needs_clarification",
      message: "which repository",
      questions: ["Does this ticket also touch github:acme/api?"],
      workScopeAsk: {
        subjectKey: "ticket:jira:AWT-1",
        askedRepositories: [
          { repositoryKey: "github:acme/api", askedBecause: "selection" },
        ],
      },
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const ctx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: {
          subjectKey: "ticket:jira:AWT-1",
          version: 3,
          entries: [
            {
              repositoryKey: "github:acme/web",
              state: "selected",
              origin: "person",
              rationale: "selected on the Repositories page",
              decidedBy: { kind: "person", actorId: "user_7", actorLabel: "Ada" },
              decidedAt: "2026-07-20T12:30:00.000Z",
            },
          ],
        },
        selectionAnswered: false,
      },
    });
    expect((await (execute as any)(makeNode("prepare_workspace"), {}, ctx)).kind).toBe(
      "needs_human_input",
    );

    await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      ctx,
      {},
      { clarificationAnswer: "Jane: use github:acme/api\n\nBob: agreed" },
    );

    const input = mocks.runPreSandboxPhase.mock.calls[1]![0];
    expect(
      input.ticket.comments.some((c: { author: string }) => c.author === "Human clarification"),
    ).toBe(false);
    expect(input.clarification).toBeUndefined();
  });

  it("answers a fresh ticket's bare repository question instead of asking it again", async () => {
    // The seam the gate broke. A fresh ticket carries a record with nothing in
    // it, and the first question it asks is the bare one, raised with no ask
    // behind it, so the record never sees the answer and writes nothing. Read
    // as a refusal that is a run which asks, is answered, hides the answer from
    // itself and asks again until the budget kills it, with nobody told why.
    mocks.runPreSandboxPhase.mockResolvedValueOnce({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [],
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const ctx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: null,
        selectionAnswered: false,
      },
    });
    const asked = await (execute as any)(makeNode("prepare_workspace"), {}, ctx);
    expect(asked).toMatchObject({
      kind: "needs_human_input",
      questions: ["Which repository should this ticket modify?"],
    });
    // The question goes on the record as an ask that lists no repository, which
    // is what makes the answer to it something the record reads at all. An ask
    // naming nothing is a different fact from no ask, and this is the door that
    // keeps them apart.
    expect(ctx.workScopeAsk).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      askedRepositories: [],
    });
    // So the answer is adjudicated, the person's own path is written as their
    // selection, and this is the record the run re-reads before the block runs
    // again. The loop is closed by the record accepting the answer, not by the
    // gate looking away.
    ctx.workScope = {
      subjectKey: "ticket:jira:AWT-1",
      scope: {
        subjectKey: "ticket:jira:AWT-1",
        version: 1,
        entries: [
          {
            repositoryKey: "github:acme/api",
            state: "selected",
            origin: "person",
            rationale: "named by the person answering the question",
            decidedBy: {
              kind: "person",
              actorId: "jira:human-1",
              actorLabel: "Jane (via Jira)",
            },
            decidedAt: "2026-07-20T13:00:00.000Z",
          },
        ],
      },
      selectionAnswered: false,
    };

    await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      ctx,
      {},
      { clarificationAnswer: "github:acme/api" },
    );

    const input = mocks.runPreSandboxPhase.mock.calls[1]![0];
    // The answer rides `clarification` and nothing else. Appended to the ticket
    // it would reach the path scanner too, which takes a repository out of a
    // reply that refused it.
    expect(
      input.ticket.comments.some((c: { author: string }) => c.author === "Human clarification"),
    ).toBe(false);
    expect(input.clarification).toEqual({
      answer: "github:acme/api",
      resolves: "repository_selection",
    });
  });

  it("answers a bare repository question no verdict ever came back for", async () => {
    // The same bare question, on the run the deploy suspended: it replays a
    // result written before the record carried a verdict, so nothing can say
    // what happened to these words. An empty record after a question that
    // showed the record NOTHING says only that nobody was ever shown anything,
    // and reading it as a refusal is the forever loop again, this time on the
    // runs least able to survive it.
    mocks.runPreSandboxPhase.mockResolvedValueOnce({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [],
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const bareCtx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: null,
        selectionAnswered: false,
      },
    });
    expect((await (execute as any)(makeNode("prepare_workspace"), {}, bareCtx)).kind).toBe(
      "needs_human_input",
    );
    expect(bareCtx.workScopeAsk).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      askedRepositories: [],
    });

    // The record untouched and no verdict on it, which is what the answer path
    // leaves behind when the clarification row carries no asked repositories.
    await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      bareCtx,
      {},
      { clarificationAnswer: "github:acme/api" },
    );

    const input = mocks.runPreSandboxPhase.mock.calls[1]![0];
    // The answer rides `clarification` and nothing else. Appended to the ticket
    // it would reach the path scanner too, which takes a repository out of a
    // reply that refused it.
    expect(
      input.ticket.comments.some((c: { author: string }) => c.author === "Human clarification"),
    ).toBe(false);
    // And it does reach the step, on the channel that says it is an answer:
    // withholding it is the forever loop this test is named for.
    expect(input.clarification).toEqual({
      answer: "github:acme/api",
      resolves: "repository_selection",
    });
  });

  it("does not ask a person to narrow a set they have already narrowed", async () => {
    // THE OWNER'S RED LINE. Discovery rebuilds this list from the ticket on
    // every run, so it comes back at twelve however carefully somebody cut it
    // to three, and until the record could say the subject had been narrowed
    // the identical question went out again and the person had been ignored.
    // Driven as two executions of the block rather than read off a field,
    // because the behaviour that must never come back is the question.
    const twelve: SelectedRepository[] = Array.from({ length: 12 }, (_, index) => ({
      provider: "github",
      repoPath: `acme/service-${index}`,
      defaultBranch: "main",
      selectedRationale: "ticket mentions the platform",
    }));
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: twelve,
    });
    mocks.blockFetchPrContextsStep.mockImplementation(
      async (repositories: SelectedRepository[]) =>
        repositories.map((repository) => ({
          repository,
          prComments: [],
          checkResults: [],
          hasConflicts: false,
        })),
    );

    const narrowCtx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: null,
        selectionAnswered: false,
      },
    });
    const asked = await (execute as any)(makeNode("prepare_workspace"), {}, narrowCtx);
    expect(asked).toMatchObject({
      kind: "needs_human_input",
      questions: [
        "More than 8 repositories are in scope. Which repositories are essential for this ticket?",
      ],
    });
    // The question names none of the twelve, so the ask lists none of them and
    // the purpose is the only thing that says which question this was.
    expect(narrowCtx.workScopeAsk).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      askedRepositories: [],
      purpose: "narrowing",
    });

    // The record as the answer left it, which is what the run re-reads before
    // the block runs again: the three they named are their own decision, and
    // the nine they did not name have no entry at all, because nobody ever put
    // those names in front of them.
    narrowCtx.workScope = {
      subjectKey: "ticket:jira:AWT-1",
      scope: {
        subjectKey: "ticket:jira:AWT-1",
        version: 1,
        entries: ["acme/service-1", "acme/service-4", "acme/service-7"].map((repoPath) => ({
          repositoryKey: `github:${repoPath}`,
          state: "selected" as const,
          origin: "person" as const,
          rationale: "named by the person answering the question",
          decidedBy: {
            kind: "person" as const,
            actorId: "jira:human-1",
            actorLabel: "Jane (via Jira)",
          },
          decidedAt: "2026-07-20T13:00:00.000Z",
        })),
      },
      selectionAnswered: false,
      narrowingAnswered: true,
    };

    const resumed = await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      narrowCtx,
      {},
      { clarificationAnswer: "service-1, service-4 and service-7" },
    );

    expect(resumed.kind).not.toBe("needs_human_input");
    // And it works on exactly what they named, rather than on whatever
    // discovery turned up again.
    expect(narrowCtx.selectedRepositories.map((r: SelectedRepository) => r.repoPath)).toEqual([
      "acme/service-1",
      "acme/service-4",
      "acme/service-7",
    ]);
  });

  it("asks the plain question when nothing a person narrowed to is in front of this run", async () => {
    // They answered, and this run can see none of what they named: a repository
    // renamed away, or one this workflow's pin does not cover. Proceeding would
    // prepare a workspace holding nothing, and re-asking them to narrow the
    // same set would be the question they already answered. So the run asks the
    // plain question instead, which is a DIFFERENT one and records no purpose.
    const twelve: SelectedRepository[] = Array.from({ length: 12 }, (_, index) => ({
      provider: "github",
      repoPath: `acme/service-${index}`,
      defaultBranch: "main",
      selectedRationale: "ticket mentions the platform",
    }));
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: twelve,
    });

    const goneCtx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: {
          subjectKey: "ticket:jira:AWT-1",
          version: 1,
          entries: [
            {
              repositoryKey: "github:acme/retired",
              state: "selected",
              origin: "person",
              rationale: "named by the person answering the question",
              decidedBy: {
                kind: "person",
                actorId: "jira:human-1",
                actorLabel: "Jane (via Jira)",
              },
              decidedAt: "2026-07-20T13:00:00.000Z",
            },
          ],
        },
        selectionAnswered: false,
        narrowingAnswered: true,
      },
    });

    const asked = await (execute as any)(makeNode("prepare_workspace"), {}, goneCtx);

    // AND IT SAYS WHAT BECAME OF THEIR ANSWER. A bare question here reads, from
    // where the person sits, as being asked what they already answered, which
    // is the complaint this whole stage exists to end. Their three were read and
    // accepted; what changed is that this run cannot reach them, and the
    // question has to carry that or it is the old behaviour wearing a new name.
    expect(asked).toMatchObject({
      kind: "needs_human_input",
      questions: [
        "The repositories chosen for this work are not available to this run:" +
          " github:acme/retired. Which repository should this ticket modify?",
      ],
    });
    expect(goneCtx.workScopeAsk).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      askedRepositories: [],
    });
  });

  it("counts the repositories it cannot name rather than printing a wall of them", async () => {
    // The sentence is read by a person in a ticket comment. Seven keys spelled
    // out is a wall they skip, and skipping it puts them back in front of a
    // question that looks like one they already answered.
    const twelve: SelectedRepository[] = Array.from({ length: 12 }, (_, index) => ({
      provider: "github",
      repoPath: `acme/service-${index}`,
      defaultBranch: "main",
      selectedRationale: "ticket mentions the platform",
    }));
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: twelve,
    });

    const manyCtx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: {
          subjectKey: "ticket:jira:AWT-1",
          version: 1,
          entries: Array.from({ length: 7 }, (_, index) => ({
            repositoryKey: `github:acme/gone-${index}`,
            state: "selected" as const,
            origin: "person" as const,
            rationale: "named by the person answering the question",
            decidedBy: {
              kind: "person" as const,
              actorId: "jira:human-1",
              actorLabel: "Jane (via Jira)",
            },
            decidedAt: "2026-07-20T13:00:00.000Z",
          })),
        },
        selectionAnswered: false,
        narrowingAnswered: true,
      },
    });

    const asked = await (execute as any)(makeNode("prepare_workspace"), {}, manyCtx);

    expect(asked).toMatchObject({
      kind: "needs_human_input",
      questions: [
        "The repositories chosen for this work are not available to this run:" +
          " github:acme/gone-0, github:acme/gone-1, github:acme/gone-2," +
          " github:acme/gone-3, github:acme/gone-4, and 2 more." +
          " Which repository should this ticket modify?",
      ],
    });
  });

  it("asks the plain question with nothing to report when a person narrowed to nothing", async () => {
    // "None of these are essential" is an answer, and it records no repository
    // by design. There is nothing that became unreachable, so a sentence about
    // the repositories they chose would name none of them.
    const twelve: SelectedRepository[] = Array.from({ length: 12 }, (_, index) => ({
      provider: "github",
      repoPath: `acme/service-${index}`,
      defaultBranch: "main",
      selectedRationale: "ticket mentions the platform",
    }));
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: twelve,
    });

    const noneCtx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: { subjectKey: "ticket:jira:AWT-1", version: 1, entries: [] },
        selectionAnswered: false,
        narrowingAnswered: true,
      },
    });

    const asked = await (execute as any)(makeNode("prepare_workspace"), {}, noneCtx);

    expect(asked).toMatchObject({
      kind: "needs_human_input",
      questions: ["Which repository should this ticket modify?"],
    });
  });

  it("passes an answer the record accepted as a person's selection", async () => {
    mocks.runPreSandboxPhase.mockResolvedValueOnce({
      status: "halt",
      outcome: "needs_clarification",
      message: "which repository",
      questions: ["Does this ticket also touch github:acme/api?"],
      workScopeAsk: {
        subjectKey: "ticket:jira:AWT-1",
        askedRepositories: [
          { repositoryKey: "github:acme/api", askedBecause: "selection" },
        ],
      },
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    // Nothing decided yet when the question goes out, which is what makes the
    // entry below this answer's doing rather than somebody else's.
    const acceptedCtx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: null,
        selectionAnswered: false,
      },
    });
    expect((await (execute as any)(makeNode("prepare_workspace"), {}, acceptedCtx)).kind).toBe(
      "needs_human_input",
    );
    // The record as the answer left it, which is what the run re-reads before
    // the block runs again (`agent-workflow.ts:1576-1585`).
    acceptedCtx.workScope = {
      subjectKey: "ticket:jira:AWT-1",
      scope: {
        subjectKey: "ticket:jira:AWT-1",
        version: 2,
        entries: [
          {
            repositoryKey: "github:acme/api",
            state: "selected",
            origin: "person",
            rationale: "named by the person answering the question",
            decidedBy: {
              kind: "person",
              actorId: "jira:human-1",
              actorLabel: "Jane (via Jira)",
            },
            decidedAt: "2026-07-20T13:00:00.000Z",
          },
        ],
      },
      selectionAnswered: true,
    };

    await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      acceptedCtx,
      {},
      { clarificationAnswer: "Jane: use github:acme/api" },
    );

    const input = mocks.runPreSandboxPhase.mock.calls[1]![0];
    // The careful reader accepted these words, so the looser one is not being
    // asked to decide anything the record has not already decided.
    // The answer rides `clarification` and nothing else. Appended to the ticket
    // it would reach the path scanner too, which takes a repository out of a
    // reply that refused it.
    expect(
      input.ticket.comments.some((c: { author: string }) => c.author === "Human clarification"),
    ).toBe(false);
    expect(input.clarification).toEqual({
      answer: "Jane: use github:acme/api",
      resolves: "repository_selection",
    });
  });

  it("passes an answer the record read and could not act on", async () => {
    // The wide half of the rule, and the half an empty record cannot express.
    // The record read these words, attributed them to the one person who wrote
    // them, and still wrote nothing: it could not make a repository out of
    // "yes, that one", or the key it recognised was selected already. Neither
    // is anybody's refusal, and the looser text scan downstream is exactly the
    // reader that might get something out of prose the strict one could not.
    // Withheld, this is the same forever loop as the bare question.
    mocks.runPreSandboxPhase.mockResolvedValueOnce({
      status: "halt",
      outcome: "needs_clarification",
      message: "which repository",
      questions: ["Does this ticket also touch github:acme/api?"],
      workScopeAsk: {
        subjectKey: "ticket:jira:AWT-1",
        askedRepositories: [
          { repositoryKey: "github:acme/api", askedBecause: "selection" },
        ],
      },
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const unreadableCtx = makeCtx({
      sandboxId: null,
      workScope: {
        subjectKey: "ticket:jira:AWT-1",
        scope: { subjectKey: "ticket:jira:AWT-1", version: 1, entries: [] },
        selectionAnswered: false,
      },
    });
    expect(
      (await (execute as any)(makeNode("prepare_workspace"), {}, unreadableCtx)).kind,
    ).toBe("needs_human_input");
    // Entries untouched, exactly as in the declined case above. Only the
    // verdict separates the two, which is why the verdict is what is read.
    unreadableCtx.workScope = {
      subjectKey: "ticket:jira:AWT-1",
      scope: { subjectKey: "ticket:jira:AWT-1", version: 1, entries: [] },
      selectionAnswered: false,
      answerAttributed: true,
    };

    await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      unreadableCtx,
      {},
      { clarificationAnswer: "yes, that one" },
    );

    const input = mocks.runPreSandboxPhase.mock.calls[1]![0];
    // The answer rides `clarification` and nothing else. Appended to the ticket
    // it would reach the path scanner too, which takes a repository out of a
    // reply that refused it.
    expect(
      input.ticket.comments.some((c: { author: string }) => c.author === "Human clarification"),
    ).toBe(false);
    expect(input.clarification).toEqual({
      answer: "yes, that one",
      resolves: "repository_selection",
    });
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

    await execute(
      makeNode("prepare_workspace"),
      {},
      // The run's budget comes from the snapshot it froze at start, not from
      // the environment this process happens to have.
      makeCtx({
        sandboxId: null,
        settings: makeRunSettings({ JOB_TIMEOUT_MS: 1000, ENABLE_REPO_MEMORY: memoryEnabled }),
      }),
    );

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
    // One observer is enough: runRepositorySetup attributes its durable phase
    // boundaries to the checks clock through that observer.
    expect(mocks.runRepositorySetup.mock.calls[0]![0]).not.toHaveProperty(
      "observeChecksBudget",
    );
  });

  it.each(SETUP_BOUNDARY_ERROR_CASES)(
    "rethrows a $label from setup while reusing a workspace",
    async ({ create, expected }) => {
      mocks.resolveChecksProvisioningStep.mockResolvedValue({
        ceilingMs: 900_000,
        config: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
      });
      const error = create();
      mocks.runRepositorySetup.mockRejectedValue(error);
      let caught: unknown;

      try {
        await ensureWorkspace(
          makeCtx({ sandboxId: "code-1", definitionNodes: SCRIPT_NODES }),
          undefined,
          {},
        );
      } catch (thrown) {
        caught = thrown;
      }

      expect(caught).toBe(error);
      expect(caught).toMatchObject(expected);
    },
  );

  it.each(SETUP_BOUNDARY_ERROR_CASES)(
    "rethrows a $label from setup after creating a workspace",
    async ({ create, expected }) => {
      mocks.resolveChecksProvisioningStep.mockResolvedValue({
        ceilingMs: 900_000,
        config: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
      });
      mocks.runPreSandboxPhase.mockResolvedValue({
        status: "continue",
        promptAdditions: { research: [], implementation: [], review: [] },
        selectedRepositories: [repo],
      });
      mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
      const error = create();
      mocks.runRepositorySetup.mockRejectedValue(error);
      const ctx = makeCtx({ sandboxId: null, definitionNodes: SCRIPT_NODES });
      let caught: unknown;

      try {
        await ensureWorkspace(ctx, undefined, {});
      } catch (thrown) {
        caught = thrown;
      }

      expect(ctx.sandboxId).toBe("sbx-9");
      expect(caught).toBe(error);
      expect(caught).toMatchObject(expected);
    },
  );

  it("hands the setup substep the observation channel it reports progress on", async () => {
    // Provisioning precedes every block that produces output, so a five minute
    // `uv sync` is indistinguishable from a hung workspace unless the batch
    // poll can say how far it has got.
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 900_000,
      config: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const observations = { emit: vi.fn() };

    const ctx = makeCtx({ sandboxId: null, definitionNodes: SCRIPT_NODES });
    await execute(
      makeNode("prepare_workspace"),
      {},
      ctx,
      {},
      makeInvocation(ctx, { observations }),
    );

    expect(mocks.runRepositorySetup).toHaveBeenCalledWith(
      expect.objectContaining({ observations }),
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

    const ctx = makeCtx({ sandboxId: null, definitionNodes: SCRIPT_NODES });
    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result).toMatchObject({
      kind: "execution_error",
      error: { category: "checks", phase: "setup" },
    });
    expect(JSON.stringify(result)).toContain("uv sync");
    // The run-level reason names the repository, the command and the exit code
    // itself. Left as the bare count with the structured failures as detail,
    // the middle elision that bounds a run reason ate the command and the exit
    // code, and the ticket read "Command: e [...] ng but the missing toolchain".
    const message = result.kind === "execution_error" ? result.error.message : "";
    expect(message).toContain(
      "Setup failed in 1 of 1 repositories: github:acme/api: uv sync (exit 127).",
    );
    expect(message).toContain("Fix the setup command on the Repository scripts screen.");
    expect(message.slice(0, message.indexOf("(exit 127)"))).not.toContain("[...]");
    // The structured failures reach the ticket comment through the context,
    // where there is room for the output tail this one-liner leaves out. Their
    // BEHAVIOUR is asserted where the comment is composed
    // (agent-pre-pr-checks-failure.test.ts); this is the handover itself.
    expect(ctx.setupFailures).toEqual([
      expect.objectContaining({ command: "uv sync", exitCode: 127, phase: "setup" }),
    ]);
  });

  it("clears a previous pass's setup failures before verifying again", async () => {
    // A second prepare node, or a resumed run that provisions cleanly this
    // time, must not report the earlier failures in a comment about a different
    // failure. The field is write-once per verification, not an accumulator.
    mocks.resolveChecksProvisioningStep.mockResolvedValue({
      ceilingMs: 900_000,
      config: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
    });
    mocks.runRepositorySetup.mockResolvedValue({
      ran: 1,
      failures: [],
      summary: "Setup completed in 1 repository.",
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const ctx = makeCtx({ sandboxId: null, definitionNodes: SCRIPT_NODES });
    ctx.setupFailures = [
      {
        provider: "github",
        repoPath: "acme/api",
        command: "uv sync",
        exitCode: 127,
        stdout: "",
        stderr: "uv: command not found",
        phase: "setup",
      },
    ];

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(ctx.setupFailures).toBeUndefined();
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

  it("puts a step's finished sentence in front of the person whole", async () => {
    // The authorization refusal the step raises for a pinned repository the
    // catalog withholds: one sentence naming what was refused, why, and the page
    // that fixes it. Longer than the 160-character snippet cap, so as a mere
    // `detail` it reached the person clipped from both ends with the repository
    // in the elided middle, which is the shape production hit on
    // wrun_01M2SDKXF5QYNCXGCMRJJQ2HFF. The step says it is a finished sentence
    // and the block leads with it.
    const refusal = repositoryNotEnabledMessage("prepare", {
      provider: "github",
      repoPath: "blazity/ai-workflow",
    });
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "halt",
      outcome: "failed",
      message: refusal,
      cause: refusal,
      messageStandsAlone: true,
    });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(refusal.length).toBeGreaterThan(160);
    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(result.error.message).toBe(refusal);
    expect(result.error.message).not.toContain("[...]");
    expect(result.error.message).toContain("github:blazity/ai-workflow");
    // The operator's prefix stays on the detail and off the person's sentence.
    expect(result.error.detail).toBe(`pre-sandbox: ${refusal}`);
  });

  it("still leads a composed halt with the category line and its cause in brackets", async () => {
    // The opposite producer, and the reason the signal is a flag rather than a
    // guess about the text: `incompleteCatalogMessage` composes step name, then
    // the provider verdicts, then advice, so the reason is in the MIDDLE. It
    // passes no `messageStandsAlone`, keeps the generic lead, and its verdicts
    // ride behind it in parentheses, which is the AIW-254 behaviour.
    const composed =
      "Select repositories failed: repository listing for gitlab is unavailable " +
      "(gitlab: GitLab projects list timed out after 15000ms), so the repository catalog was incomplete. " +
      "No deterministic repository signal resolved the selection, and choosing from a partial catalog could pick the wrong repository. " +
      "Retry once the provider recovers, or name the repository path in the ticket.";
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "halt",
      outcome: "failed",
      message: composed,
      cause: "gitlab: GitLab projects list timed out after 15000ms",
    });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(result.error.message).toBe(
      "The workspace environment could not complete this block." +
        " (gitlab: GitLab projects list timed out after 15000ms)",
    );
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

  /**
   * The founding complaint of this feature, end to end.
   *
   * Somebody excluded a repository weeks ago. Selection refuses it and does NOT
   * halt, so the halt text that names it is never composed, discovery finds
   * nothing else, and the run asks a bare "which repository should this ticket
   * modify?" of the same person whose own decision emptied the list.
   *
   * The invariant, on the line the ruling in `agent-workflow.ts` draws: what was
   * left out rides the question, because it is a fact about this run's workspace
   * and the person cannot answer without it; the sentence about taking the
   * exclusion back rides the ticket comment only, because the questions become
   * the agent's prompts and its "Human decisions" memory, and that is the
   * channel this system PLACES text in. Each absence assertion is paired with a
   * positive control, so an assertion cannot pass on an empty surface.
   */
  it("names what the selection refused in the bare question, and takes the reversal to the ticket only", async () => {
    const refusal =
      "github:acme/api was excluded on this work, so the run started without it.";
    const reversal =
      "Excluding a repository is not final: this work's repository list can be changed" +
      " through the work scope API or the work_scope.edit tool," +
      " and the next run starts from the changed list.";
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [],
      workScopeLeftOut: [{ repositoryKey: "github:acme/api", reason: refusal }],
      workScopeRecoveryNotes: [reversal],
    });
    const ctx = makeCtx({ sandboxId: null });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("needs_human_input");
    const questions = result.kind === "needs_human_input" ? result.questions : [];
    expect(questions).toEqual([
      `${refusal} Which repository should this ticket modify?`,
    ]);
    expect(questions.join(" ")).not.toContain("not final");

    // The ticket comment, which is where the sentence does ship.
    const comment = formatClarificationQuestionsComment({
      questions,
      suggestedAnswers: null,
      dashboardUrl: "https://app/ticket/AWT-402?run=wrun_1",
      aiColumnName: "AI",
      expiresAtIso: null,
      repositoryRecoveryNotes: ctx.workScopeRecoveryNotes,
    });
    expect(comment).toContain(refusal);
    expect(comment).toContain(reversal);

    // Answered, the same question becomes a clarification round, and the round
    // is rendered verbatim into the agent's research prompt.
    const round = { questions, answer: "Use acme/web." };
    const prompt = assembleResearchPlanContext({
      ticket: {
        identifier: "AWT-402",
        title: "Rename the client",
        description: "Touches acme/api and acme/web.",
        acceptanceCriteria: "",
        comments: [],
        clarifications: [round],
      },
      prompt: "Plan the work.",
      branchName: "blazebot/awt-402",
    });
    expect(prompt).toContain("## Clarifications (Q&A)");
    expect(prompt).toContain(refusal);
    expect(prompt).not.toContain("not final");

    // And into ai-workflow/memory/AWT-402.md, under a heading that tells the
    // agent a person decided this and not to edit it.
    const memory = renderHumanDecisionsSection([round]);
    expect(memory).toContain("## Human decisions (from the dashboard)");
    expect(memory).toContain(refusal);
    expect(memory).not.toContain("not final");
  });

  it("asks the bare question unchanged when the selection refused nothing", async () => {
    // The prefix is not decoration. A run with nothing to explain asks the
    // question it always asked, so the sentence in front of it always means
    // something happened.
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [],
      workScopeLeftOut: [],
      workScopeRecoveryNotes: [],
    });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result).toMatchObject({
      kind: "needs_human_input",
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

    expect(mocks.blockPrTriggerRepositoriesStep).toHaveBeenCalledWith(
      "run-1",
      pr,
      ctx.repositories,
      { workScope: null },
    );
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

  it("recreates an approved run for a repository the run's catalog enables", async () => {
    mocks.listRepositories.mockResolvedValue([availableApiRepo()]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    const ctx = makeCtx({
      sandboxId: null,
      entry: approvedScopeEntry(validApprovedScope),
      repositories: { activated: true, enabledKeys: ["github:acme/api"] },
      repositoryScope: {
        repositories: [{ provider: "github", repoPath: "acme/api" }],
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(ctx.selectedRepositories).toEqual([
      { ...repo, expectedResearchBaseSha: BASE_SHA },
    ]);
  });

  it("refuses an approved repository the run's catalog withholds by name, before any sandbox", async () => {
    // The pin used to widen the allowlist; it no longer does, so the same
    // definition that reached acme/api above cannot reach it here. The refusal
    // is the catalog's own sentence, not the generic availability one: the
    // operator's next action is to enable the row, not to hunt a provider
    // change. And it happens before provisioning, so no agent invocation and no
    // sandbox is spent on a run that cannot finish.
    mocks.listRepositories.mockResolvedValue([availableApiRepo()]);

    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({
        sandboxId: null,
        entry: approvedScopeEntry(validApprovedScope),
        repositories: { activated: true, enabledKeys: ["github:acme/other"] },
        repositoryScope: {
          repositories: [{ provider: "github", repoPath: "acme/api" }],
        },
      }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain(
        "Refusing to prepare github:acme/api: this repository was not enabled " +
          "in the repository catalog when this run started. Enable it on the " +
          "Repositories page and re-dispatch the ticket.",
      );
      // Not a sandbox fault, and the category is what decides which sentence
      // leads the ticket comment.
      expect(result.error.category).toBe("configuration");
      expect(result.error.detail).not.toContain("unavailable or no longer allowed");
    }
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
    expect(mocks.runPreSandboxPhase).not.toHaveBeenCalled();
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

  it("does not send an approved plan back for replanning when the settings could not be read", async () => {
    // An empty listing made the approved repository look gone, and the run
    // asked for a replan of a plan that was still good.
    const { IntegrationSettingsUnreadableError } = await import(
      "../../../services/integrations/usable.js"
    );
    mocks.listRepositories.mockRejectedValue(
      new IntegrationSettingsUnreadableError("so no repository could be listed", "connection terminated"),
    );
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      makeCtx({
        sandboxId: null,
        entry: approvedScopeEntry({
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
        }),
      }),
    );

    if (result.kind !== "execution_error") throw new Error("expected a refusal");
    expect(result.error.category).toBe("engine");
    expect(result.error.message).toContain("could not read the deployment's integration settings");
    expect(JSON.stringify(result.error)).not.toContain("replan");
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
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
      // The pre-sandbox phase filters against the run's frozen list, not the
      // environment: a pin narrows inside the catalog and never widens it.
      repositoryAccess: ctx.repositories,
      // And the run's frozen settings, so a step inside the phase reads a flag
      // from the snapshot rather than from the deployment's environment.
      settings: ctx.settings,
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

    const ctx = makeCtx({ sandboxId: null });
    const result = await execute(
      makeNode("prepare_workspace"),
      {},
      ctx,
      {},
      makeInvocation(ctx, { observations: { emit } }),
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
      ctx.repositories,
      { workScope: null },
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
