import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the work scope record may and may not reach, seen from the run rather
 * than from one pure function.
 *
 * Three claims, and each is a way the record could quietly take a run over:
 * a pull request run reads the record but writes nothing back to it, an
 * approved plan ignores the subject's record entirely and works from the
 * snapshot a person approved, and a run whose frozen run-start result carries
 * no record at all takes exactly the path it took before any of this existed.
 *
 * The seams are the same ones prepare-workspace's own suite mocks. The pull
 * request repository step is deliberately NOT mocked: its no-write claim is
 * only worth something if the real body runs.
 */
const mocks = vi.hoisted(() => ({
  env: {
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_API_KEY: "codex-key",
    JOB_TIMEOUT_MS: 1000,
  } as Record<string, unknown>,
  runPreSandboxPhase: vi.fn(),
  blockFetchPrContextsStep: vi.fn(),
  applyRunWorkScopePlan: vi.fn(),
  readConnectedWorkScopeFacts: vi.fn(),
  findRunPrSiblings: vi.fn(),
  listWorkflowOwnedBranchesForTicket: vi.fn(),
  listRepositories: vi.fn(),
  createRepositoryVCS: vi.fn(),
  buildSandboxProviderConfigs: vi.fn(),
  provisionMultiRepo: vi.fn(),
  agentInstall: vi.fn(),
  agentConfigure: vi.fn(),
  createAgentAdapter: vi.fn(),
  registerSandbox: vi.fn(),
  sandboxGet: vi.fn(),
  hydrateWorkspaceMemoryStep: vi.fn(),
  seedRepoMemoryStep: vi.fn(),
  captureDefaultBranchFilesStep: vi.fn(),
  promoteRepositoryWriteScopeStep: vi.fn(),
  resolveChecksProvisioningStep: vi.fn(),
  runRepositorySetup: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: mocks.env,
  getConfiguredVcsProviders: () => [{ kind: "github" }],
}));
vi.mock("../steps/pre-sandbox-runner.js", () => ({
  runPreSandboxPhase: mocks.runPreSandboxPhase,
}));
// Partial on purpose: the sibling step under test stays real, and only the PR
// context fetch beside it is stubbed.
vi.mock("../blocks/fetch-pr-context/execute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../blocks/fetch-pr-context/execute.js")>()),
  blockFetchPrContextsStep: mocks.blockFetchPrContextsStep,
}));
vi.mock("../../db/repositories/work-scope.js", () => ({
  applyConnectedRunWorkScopePlan: mocks.applyRunWorkScopePlan,
  readConnectedWorkScopeFacts: mocks.readConnectedWorkScopeFacts,
}));
vi.mock("../../db/repositories/runs.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
  listConnectedWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
  findRunPrSiblings: mocks.findRunPrSiblings,
  findConnectedRunPrSiblings: mocks.findRunPrSiblings,
}));
vi.mock("../steps/repository-promotion.js", () => ({
  promoteRepositoryWriteScopeStep: mocks.promoteRepositoryWriteScopeStep,
}));
vi.mock("../steps/memory-steps.js", () => ({
  hydrateWorkspaceMemoryStep: mocks.hydrateWorkspaceMemoryStep,
}));
vi.mock("../steps/repo-seed-steps.js", () => ({
  seedRepoMemoryStep: mocks.seedRepoMemoryStep,
}));
vi.mock("../steps/repo-memory-steps.js", () => ({
  captureDefaultBranchFilesStep: mocks.captureDefaultBranchFilesStep,
}));
vi.mock("../../sandbox/manager.js", () => ({
  SandboxManager: vi.fn(() => ({ provisionMultiRepo: mocks.provisionMultiRepo })),
}));
vi.mock("../blocks/pre-pr-checks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../blocks/pre-pr-checks.js")>()),
  resolveChecksProvisioningStep: mocks.resolveChecksProvisioningStep,
  runRepositorySetup: mocks.runRepositorySetup,
}));
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: mocks.createAgentAdapter,
}));
// Both provider-backed calls this run path makes: the adapter for a repository
// and the listing of everything the connected providers offer. The pin
// predicate and the scope helpers next door are pure and stay real.
vi.mock("../support/vcs-runtime.js", () => ({
  buildSandboxProviderConfigs: mocks.buildSandboxProviderConfigs,
  createRepositoryVCS: (...args: unknown[]) => mocks.createRepositoryVCS(...args),
  listVcsRepositories: async () => ({
    repositories: await mocks.listRepositories(),
    failures: [],
  }),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../support/adapters.js", () => ({
  createAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));

import type { WorkScope, WorkScopeEntry } from "@shared/contracts";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import { execute } from "../blocks/prepare-workspace/execute.js";
import { makeCtx, makeNode, makePrPayload } from "../blocks/support/test-support.js";

const BASE_SHA = "a".repeat(40);
const SUBJECT = "ticket:jira:AWT-1";

const RUN_ACTOR = {
  kind: "run" as const,
  runId: "run-0",
  definitionId: 1,
  definitionVersion: 1,
};

function selectedEntry(repositoryKey: string): WorkScopeEntry {
  return {
    repositoryKey,
    state: "selected",
    origin: "person",
    rationale: "a person chose it on this ticket",
    decidedBy: RUN_ACTOR,
    decidedAt: "2026-09-01T00:00:00.000Z",
  };
}

function recordHolding(...repositoryKeys: string[]): {
  subjectKey: string;
  scope: WorkScope;
  selectionAnswered: boolean;
} {
  return {
    subjectKey: SUBJECT,
    scope: { subjectKey: SUBJECT, version: 3, entries: repositoryKeys.map(selectedEntry) },
    selectionAnswered: true,
  };
}

function catalogEntry(provider: string, repoPath: string) {
  const [owner, name] = repoPath.split("/");
  return {
    provider,
    repoPath,
    name,
    owner,
    defaultBranch: "main",
    description: "",
    webUrl: `https://${provider}.test/${repoPath}`,
    topics: [] as string[],
    archived: false,
    private: true,
  };
}

const repo: SelectedRepository = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "ticket mentions api",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createAgentAdapter.mockImplementation((kind: string) => ({
    kind,
    cliSpec: { displayName: kind, binName: kind },
    install: mocks.agentInstall,
    configure: mocks.agentConfigure,
  }));
  mocks.resolveChecksProvisioningStep.mockResolvedValue({ ceilingMs: 60 * 60_000, config: null });
  mocks.runRepositorySetup.mockResolvedValue({
    ran: 0,
    failures: [],
    summary: "No repository configured setup commands.",
  });
  mocks.buildSandboxProviderConfigs.mockResolvedValue([]);
  mocks.captureDefaultBranchFilesStep.mockResolvedValue({});
  mocks.listRepositories.mockResolvedValue([]);
  mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([]);
  mocks.findRunPrSiblings.mockResolvedValue({ status: "none" });
  // Echoes the selection back, because the provisioning input, and with it
  // `ctx.selectedRepositories`, is built from these contexts: a fixed list here
  // would hide whichever repository the selection actually chose.
  mocks.blockFetchPrContextsStep.mockImplementation(
    async (repositories: SelectedRepository[]) =>
      repositories.map((repository) => ({
        repository,
        prComments: [],
        checkResults: [],
        hasConflicts: false,
      })),
  );
  mocks.createRepositoryVCS.mockReturnValue({
    getBranchSha: vi.fn().mockResolvedValue(BASE_SHA),
    getBranchShaIfExists: vi.fn().mockResolvedValue(BASE_SHA),
  });
  mocks.sandboxGet.mockResolvedValue({ sandboxId: "sbx-discovery" });
  mocks.agentInstall.mockResolvedValue(undefined);
  mocks.agentConfigure.mockResolvedValue(undefined);
  mocks.provisionMultiRepo.mockImplementation(async (...args: unknown[]) => {
    const lifecycle = args[4] as { onCreated?: (id: string) => Promise<void> } | undefined;
    await lifecycle?.onCreated?.("sbx-9");
    return {
      sandbox: { sandboxId: "sbx-9" },
      workspaceManifest: { version: 1, repositories: [] },
    };
  });
});

describe("a pull request run and the work scope record", () => {
  function prCtx(
    workScope?: ReturnType<typeof recordHolding>,
    repositoryScope?: { repositories: Array<{ provider: "github"; repoPath: string }> },
  ) {
    const pr = makePrPayload();
    return {
      pr,
      ctx: makeCtx({
        sandboxId: null,
        ...(repositoryScope ? { repositoryScope } : {}),
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_created",
          subjectKey: SUBJECT,
          ticketKey: "AWT-1",
          ownerToken: "owner:test",
          definitionId: 1,
          definitionVersion: 1,
          scope: "workflow_owned",
          pr,
        },
        ...(workScope ? { workScope } : {}),
      }),
    };
  }

  function siblingIsOpen(): void {
    mocks.findRunPrSiblings.mockResolvedValue({
      status: "siblings",
      runId: "implementation-run",
      siblings: [
        {
          provider: "github",
          repoPath: "acme/contract",
          id: 13,
          url: "https://github.test/acme/contract/pull/13",
          headSha: "published-sha",
        },
      ],
    });
    mocks.listRepositories.mockResolvedValue([
      catalogEntry("github", "acme/contract"),
      catalogEntry("github", "acme/web"),
    ]);
    mocks.createRepositoryVCS.mockReturnValue({
      getPRHead: vi.fn().mockResolvedValue({
        state: "open",
        headRef: "feature/contract",
        headSha: "current-sibling-sha",
      }),
      getBranchShaIfExists: vi.fn().mockResolvedValue("current-sibling-sha"),
    });
  }

  it("selects its own repository and its siblings exactly as it did before the record existed", async () => {
    siblingIsOpen();
    // The record holds only what the pull request already brings, so a run that
    // reads it has nothing to add and must land on today's two repositories.
    const { pr, ctx } = prCtx(recordHolding("github:acme/api"));

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(ctx.selectedRepositories.map((repository) => repository.repoPath)).toEqual([
      pr.repoPath,
      "acme/contract",
    ]);
    expect(ctx.selectedRepositories[1]).toMatchObject({
      reviewPullRequest: { id: 13, branch: "feature/contract" },
    });
  });

  it("writes no trail row", async () => {
    siblingIsOpen();
    const { ctx } = prCtx(recordHolding("github:acme/api", "github:acme/web"));

    await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.applyRunWorkScopePlan).not.toHaveBeenCalled();
  });

  it("leaves out a recorded repository the definition's pin does not name", async () => {
    siblingIsOpen();
    // The pin is a capability bound, so it outranks the record: a repository a
    // person put on the ticket is still outside what this definition may check
    // out, and the run has to come back without it rather than around it.
    const { ctx } = prCtx(recordHolding("github:acme/api", "github:acme/web"), {
      repositories: [
        { provider: "github", repoPath: "acme/api" },
        { provider: "github", repoPath: "acme/contract" },
      ],
    });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(ctx.selectedRepositories.map((repository) => repository.repoPath)).toEqual([
      "acme/api",
      "acme/contract",
    ]);
  });

  it("starts from the record, so a repository recorded on this work joins the review", async () => {
    siblingIsOpen();
    const { ctx } = prCtx(recordHolding("github:acme/api", "github:acme/web"));

    await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(ctx.selectedRepositories.map((repository) => repository.repoPath)).toEqual([
      "acme/api",
      "acme/contract",
      "acme/web",
    ]);
  });
});

describe("an approved plan and the work scope record", () => {
  it("works from the snapshot a person approved and ignores the subject's record", async () => {
    mocks.listRepositories.mockResolvedValue([catalogEntry("github", "acme/api")]);
    const ctx = makeCtx({
      sandboxId: null,
      // The record names a repository the approved plan does not. A plan a
      // person approved is the whole selection; anything else would put a
      // repository into an approved run that nobody approved.
      workScope: recordHolding("github:acme/api", "github:acme/web"),
      entry: {
        kind: "plan_approved",
        subjectKey: SUBJECT,
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
    expect(ctx.selectedRepositories.map((repository) => repository.repoPath)).toEqual([
      "acme/api",
    ]);
    expect(mocks.runPreSandboxPhase).not.toHaveBeenCalled();
    expect(mocks.applyRunWorkScopePlan).not.toHaveBeenCalled();
  });
});

describe("a run whose run-start result carries no work scope", () => {
  it("hands the pre-sandbox phase no record, no policy and no actor, and writes nothing", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    const ctx = makeCtx({ sandboxId: null });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    const [phaseInput] = mocks.runPreSandboxPhase.mock.calls[0] as [Record<string, unknown>];
    // Absent keys, not undefined values: absent is what every run had before
    // this shipped, and a present key holding undefined is a record nobody read
    // standing in for one that was never there.
    expect(Object.keys(phaseInput)).not.toContain("workScope");
    expect(Object.keys(phaseInput)).not.toContain("workScopePolicy");
    expect(Object.keys(phaseInput)).not.toContain("workScopeActor");
    expect(Object.keys(phaseInput)).not.toContain("botAccountId");
    expect(ctx.selectedRepositories.map((repository) => repository.repoPath)).toEqual([
      "acme/api",
    ]);
    expect(mocks.applyRunWorkScopePlan).not.toHaveBeenCalled();
  });

  it("hands all three down together once the run carries them", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    const ctx = makeCtx({
      sandboxId: null,
      workScope: recordHolding("github:acme/api"),
      workScopePolicy: { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
      botAccountId: "bot-1",
    });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    const [phaseInput] = mocks.runPreSandboxPhase.mock.calls[0] as [Record<string, unknown>];
    expect(phaseInput.workScope).toEqual(recordHolding("github:acme/api"));
    expect(phaseInput.workScopePolicy).toEqual({
      candidates: { kind: "enabled_catalog" },
      expansion: "ask_once",
    });
    // Named by the run that decided, so a later run can rank this run's entries
    // against a person's and against its own.
    expect(phaseInput.workScopeActor).toEqual({
      kind: "run",
      runId: "run-1",
      definitionId: 1,
      definitionVersion: 1,
    });
    expect(phaseInput.botAccountId).toBe("bot-1");
  });
});

/**
 * A source tripwire, deliberately narrow, in the style of the repository memory
 * gate above `agent-workflow.ts`'s call sites.
 *
 * `awaitClarification` is a closure inside `agentWorkflowBody`, reachable only
 * by driving the v2 scheduler to a pause, so no test can invoke it. What the
 * consume itself does is proved for real in `work-scope/context.test.ts`. This
 * asserts the one thing left: that the clarification the run parks on is still
 * built from that consume. It cannot tell a live wire from a dead local. Treat
 * a failure as "go read the call site".
 */
const workflowLines = readFileSync(
  fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
  "utf8",
).split("\n");

describe("the repository ask reaches the clarification it was raised for", () => {
  it("still consumes the ask above the step that creates the clarification, and passes it in", () => {
    const index = workflowLines.findIndex((line) => line.includes("prepareClarificationHookStep({"));
    expect(index, "prepareClarificationHookStep is no longer called in agent-workflow.ts").toBeGreaterThan(-1);

    const above = workflowLines.slice(Math.max(0, index - 12), index);
    expect(
      above.some((line) => line.includes("consumeWorkScopeAsk(ctx)")),
      "the ask is no longer taken off the run context before the question is put, so a later question could inherit it",
    ).toBe(true);

    const args = workflowLines.slice(index, index + 14);
    expect(
      args.some((line) => line.includes("workScopeAsk")),
      "the asked repositories no longer travel with the question, so the answer settles nothing",
    ).toBe(true);
  });

  /**
   * The sibling claim, on the same closure and for the same reason.
   *
   * What a person can do about a repository this run left out ships on the
   * ticket comment and on nothing else. The rendering is proved for real in
   * `services/clarifications/comment-format.test.ts`, and the absence from the
   * prompts and the memory file in
   * `engine/blocks/prepare-workspace/prepare-workspace.test.ts`. This asserts
   * the wire between them, and that it is bound to the ask rather than to the
   * run: a question about an API shape later in the same run must not inherit a
   * sentence about repositories nobody asked it about.
   */
  it("hands the reversal sentence to the ticket comment, and binds it to a question about repositories", () => {
    const index = workflowLines.findIndex((line) =>
      line.includes("postClarificationQuestionsCommentStep("),
    );
    expect(
      index,
      "postClarificationQuestionsCommentStep is no longer called in agent-workflow.ts",
    ).toBeGreaterThan(-1);

    const above = workflowLines.slice(Math.max(0, index - 6), index);
    expect(
      above.some((line) => line.includes("workScopeAsk && ctx.workScopeRecoveryNotes")),
      "the reversal sentence is no longer bound to the ask, so an ordinary later question in the same run inherits a sentence about repositories it never asked about",
    ).toBe(true);

    const args = workflowLines.slice(index, index + 12);
    expect(
      args.some((line) => line.includes("repositoryRecoveryNotes")),
      "the reversal sentence no longer reaches the ticket comment, so the person who meets the bare question is never told the exclusion can be taken back",
    ).toBe(true);
  });
});
