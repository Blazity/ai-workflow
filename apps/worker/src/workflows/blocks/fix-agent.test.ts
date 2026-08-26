import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  checkPhaseDone: vi.fn(),
  collectPhase: vi.fn(),
  assembleFixContext: vi.fn(),
  setCommitGuard: vi.fn(),
  artifactPaths: vi.fn(),
  buildPhaseScript: vi.fn(),
  parseAgentOutput: vi.fn(),
  parseAgentOutputProtocol: vi.fn(),
  extractUsage: vi.fn(),
  writeFiles: vi.fn(),
  runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
  ensureWorkspace: vi.fn(),
  maybePromoteTicketWorkspaceWrites: vi.fn().mockResolvedValue(null),
  inspectFixWorkspace: vi.fn(),
  restoreReadOnlyFixRepositories: vi.fn(),
  prepareHarnessAgentInvocation: vi.fn(),
  pollPhaseUntilDone: vi.fn().mockResolvedValue(true),
  stopPhaseCommand: vi.fn().mockResolvedValue(undefined),
  findRunPrSiblings: vi.fn(),
  publishTrustedWorkspaceFromSandbox: vi.fn(),
  findWorkflowOwnedPullRequestIdentity: vi.fn(),
  upsertWorkflowOwnedBranch: vi.fn(),
  recordWorkflowOwnedPullRequestPublishedHead: vi.fn(),
}));

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  sleep: mocks.sleep,
}));
vi.mock("../../sandbox/poll-agent.js", () => ({
  checkPhaseDone: mocks.checkPhaseDone,
  collectPhase: mocks.collectPhase,
  collectPhaseReplayDiagnostics: mocks.collectPhase,
}));
vi.mock("../../sandbox/context.js", () => ({
  assembleFixContext: mocks.assembleFixContext,
}));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({ writeFiles: mocks.writeFiles, runCommand: mocks.runCommand })),
  },
}));
vi.mock("./poll-phase.js", () => ({
  pollPhaseUntilDone: mocks.pollPhaseUntilDone,
  stopPhaseCommand: mocks.stopPhaseCommand,
}));
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: vi.fn(() => ({
    cliSpec: {
      kind: "claude",
      packageName: "@anthropic-ai/claude-code",
      version: "2.1.216",
      executable: "claude",
      protocol: "claude-json-2.1.216",
    },
    setCommitGuard: mocks.setCommitGuard,
    artifactPaths: mocks.artifactPaths,
    buildPhaseScript: mocks.buildPhaseScript,
    parseAgentOutputProtocol: mocks.parseAgentOutputProtocol,
    extractUsage: mocks.extractUsage,
  })),
}));
vi.mock("./prepare-workspace.js", () => ({
  ensureWorkspace: mocks.ensureWorkspace,
  maybePromoteTicketWorkspaceWrites: mocks.maybePromoteTicketWorkspaceWrites,
}));
vi.mock("./agent-sandbox.js", () => ({
  prepareHarnessAgentInvocationStep: mocks.prepareHarnessAgentInvocation,
}));
vi.mock("./fix-workspace-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fix-workspace-state.js")>()),
  inspectFixWorkspace: mocks.inspectFixWorkspace,
  restoreReadOnlyFixRepositories: mocks.restoreReadOnlyFixRepositories,
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../db/queries/run-pr-siblings.js", () => ({
  findRunPrSiblings: mocks.findRunPrSiblings,
}));
vi.mock("../../sandbox/trusted-workspace-publisher.js", () => ({
  publishTrustedWorkspaceFromSandbox: (...args: any[]) =>
    mocks.publishTrustedWorkspaceFromSandbox(...args),
}));
vi.mock("../../db/queries/workflow-owned-branches.js", () => ({
  findWorkflowOwnedPullRequestIdentity: (...args: any[]) =>
    mocks.findWorkflowOwnedPullRequestIdentity(...args),
  upsertWorkflowOwnedBranch: (...args: any[]) =>
    mocks.upsertWorkflowOwnedBranch(...args),
  recordWorkflowOwnedPullRequestPublishedHead: (...args: any[]) =>
    mocks.recordWorkflowOwnedPullRequestPublishedHead(...args),
}));

import {
  buildPrFixPublicationInput,
  execute,
  paramsSchema,
} from "./fix-agent.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeHarnessRuntime,
  makeNode,
  makePrPayload,
  runControlErrorCases,
} from "./test-support.js";

const usage = {
  cost_usd: 0.5,
  tokens: null,
  duration_ms: 10,
  duration_api_ms: 10,
  num_turns: 1,
};

/** A pr_trigger run whose workspace can publish a fix back to the reviewed PR. */
function prFixCtx(pr: ReturnType<typeof makePrPayload>) {
  return makeCtx({
    entry: {
      kind: "pr_trigger",
      triggerType: "trigger_pr_updated",
      subjectKey: "ticket:jira:AWT-1",
      ticketKey: "AWT-1",
      ownerToken: "owner:test",
      definitionId: 1,
      definitionVersion: 1,
      scope: "workflow_owned",
      pr,
    },
    repositoryScope: { repositories: [{ provider: "github", repoPath: "acme/api" }] },
    workspaceManifest: {
      version: 2,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          slug: "acme__api",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: pr.headRef,
          selectedRationale: "PR fix",
          access: "write",
        },
      ],
    },
  });
}

function pathsFor(phase: string) {
  return {
    wrapper: `/tmp/${phase}-wrapper.sh`,
    input: `/tmp/${phase}-requirements.md`,
    stdout: `/tmp/${phase}-stdout.txt`,
    stderr: `/tmp/${phase}-stderr.txt`,
    exitCode: `/tmp/${phase}-exit-code`,
    sentinel: `/tmp/${phase}-done`,
    structuredOutput: null,
  };
}

describe("fix_agent paramsSchema", () => {
  it("bounds maxMinutes, defaults it to 25, and rejects unknown keys", () => {
    const parsed = paramsSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.maxMinutes).toBe(25);
    expect(paramsSchema.safeParse({ maxMinutes: 4 }).success).toBe(false);
    expect(paramsSchema.safeParse({ maxMinutes: 61 }).success).toBe(false);
    expect(paramsSchema.safeParse({ instructions: "x".repeat(4001) }).success).toBe(false);
    expect(paramsSchema.safeParse({ provider: "codex", model: "gpt-5" }).success).toBe(true);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("fix_agent execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRunPrSiblings.mockResolvedValue({
      status: "none",
      runId: "published-run",
      current: { provider: "github", repoPath: "acme/api", id: 42, url: "https://github/pr/42" },
    });
    mocks.assembleFixContext.mockReturnValue("FIX INPUT");
    mocks.artifactPaths.mockImplementation((phase: string) => pathsFor(phase));
    mocks.buildPhaseScript.mockReturnValue("#!/bin/bash");
    mocks.checkPhaseDone.mockResolvedValue(true);
    mocks.collectPhase.mockResolvedValue({
      stdout: "raw",
      stderr: "",
      structuredOutput: null,
      exitCode: 0,
    });
    mocks.parseAgentOutputProtocol.mockImplementation(() => ({
      ok: true,
      value: mocks.parseAgentOutput(),
    }));
    mocks.extractUsage.mockReturnValue(usage);
    mocks.ensureWorkspace.mockImplementation(async (ctx) => {
      ctx.sandboxId ??= "sbx-auto";
      return {
        kind: "next",
        output: {
          status: "ok",
          sandboxId: ctx.sandboxId,
          repositories: [],
          workspace: { id: ctx.sandboxId, repositories: [] },
        },
      };
    });
    mocks.inspectFixWorkspace.mockResolvedValue({ commits: [], unresolvedConflicts: [] });
    mocks.restoreReadOnlyFixRepositories.mockResolvedValue([]);
    mocks.prepareHarnessAgentInvocation.mockResolvedValue({
      ok: true,
      value: undefined,
    });
    mocks.runCommand.mockImplementation((command) =>
      command === "chmod"
        ? {
            exitCode: 0,
            stdout: vi.fn().mockResolvedValue(""),
            stderr: vi.fn().mockResolvedValue(""),
          }
        : { cmdId: "cmd-2", exitCode: null },
    );
    mocks.pollPhaseUntilDone.mockResolvedValue(true);
    mocks.stopPhaseCommand.mockResolvedValue(undefined);
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
      pushed: true,
      repositories: [],
    });
    mocks.findWorkflowOwnedPullRequestIdentity.mockResolvedValue(undefined);
    mocks.upsertWorkflowOwnedBranch.mockResolvedValue(undefined);
    mocks.recordWorkflowOwnedPullRequestPublishedHead.mockResolvedValue(true);
  });

  it("passes only serializable data across the fix publication step boundary", () => {
    const pr = makePrPayload();
    const ctx = makeCtx({
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_updated",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr,
      },
      repositoryScope: {
        repositories: [{ provider: "github", repoPath: "acme/api" }],
      },
      workspaceManifest: {
        version: 2,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            slug: "acme__api",
            localPath: "/vercel/sandbox",
            defaultBranch: "main",
            branchName: pr.headRef,
            selectedRationale: "PR fix",
            access: "write",
          },
        ],
      },
    });

    const input = buildPrFixPublicationInput(ctx, "sbx-1");

    expect(input).toEqual({
      sandboxId: "sbx-1",
      workspaceManifest: ctx.workspaceManifest,
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner:test",
      runId: ctx.runId,
      repositoryScope: ctx.repositoryScope,
      pr,
    });
    expect(input).not.toHaveProperty("ctx");
    expect(() => structuredClone(input)).not.toThrow();
  });

  it("carries the head the push will create so anti-recursion can be armed first", () => {
    const pr = makePrPayload();
    const ctx = prFixCtx(pr);

    const input = buildPrFixPublicationInput(ctx, "sbx-1", {
      commits: [
        { provider: "github", repoPath: "acme/api", sha: "earlier123" },
        { provider: "github", repoPath: "acme/other", sha: "sibling999" },
        { provider: "github", repoPath: "acme/api", sha: "fix123" },
      ],
      unresolvedConflicts: [],
    });

    expect(input?.intendedHead).toBe("fix123");
    expect(() => structuredClone(input)).not.toThrow();
  });

  it("registers the intended head before pushing it", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
    mocks.inspectFixWorkspace
      .mockResolvedValueOnce({ commits: [], unresolvedConflicts: [] })
      .mockResolvedValueOnce({
        commits: [{ provider: "github", repoPath: "acme/api", sha: "fix123" }],
        unresolvedConflicts: [],
      });

    const pr = makePrPayload();
    await execute(makeNode("fix_agent"), {}, prFixCtx(pr));

    expect(mocks.recordWorkflowOwnedPullRequestPublishedHead).toHaveBeenCalledWith(
      expect.anything(),
      {
        provider: pr.provider,
        repoPath: pr.repoPath,
        prNumber: pr.prNumber,
        headSha: "fix123",
      },
    );
    // Order is the whole point: the provider webhook for this push arrives
    // before a post-push write would land, and an unrecognised push supersedes
    // the run that made it.
    const registered =
      mocks.recordWorkflowOwnedPullRequestPublishedHead.mock.invocationCallOrder[0];
    const published = mocks.publishTrustedWorkspaceFromSandbox.mock.invocationCallOrder[0];
    expect(registered).toBeLessThan(published);
  });

  it("implicitly ensures a workspace when none is attached", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
    const ctx = makeCtx({ sandboxId: null });
    const execution = { clarificationAnswer: "Use github:acme/api" };
    const result = await execute(makeNode("fix_agent"), {}, ctx, {}, execution);

    expect(mocks.ensureWorkspace).toHaveBeenCalledWith(ctx, execution);
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "fixed",
        workspaceId: "sbx-auto",
        commits: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
        summary: "patched",
      },
    });
  });

  describe("review ledger", () => {
    const ledgerCtx = () => {
      const ctx = prFixCtx(makePrPayload());
      ctx.reviewLedger = {
        feed: {
          threads: [
            {
              threadId: "d-1",
              alias: "T1",
              source: "human",
              resolvable: true,
              awaitingHuman: false,
              filePath: "src/a.ts",
              line: 4,
              notes: [
                {
                  author: "alice",
                  body: "restore the null check",
                  createdAt: "2026-08-20T10:00:00.000Z",
                  isLedgerReply: false,
                },
              ],
            },
          ],
          truncated: 0,
          contextTruncated: 0,
          snapshotAt: "2026-08-21T09:00:00.000Z",
        },
        dispositions: [],
        verification: null,
      };
      return ctx;
    };

    it("ends as a clean no-op without starting the agent when the feed has zero work items", async () => {
      // A re-dispatch on a fully parked PR: every thread is waiting on a human,
      // so the run owes nobody anything. Running the agent anyway ends with the
      // legacy "made no commits" death at the publish guard (prod round C).
      const ctx = ledgerCtx();
      const thread = ctx.reviewLedger!.feed.threads[0]!;
      thread.awaitingHuman = true;
      thread.notes.push({
        author: "ai-workflow",
        body: "answered <!-- ai-workflow:ledger:d-1 -->",
        createdAt: "2026-08-21T09:30:00.000Z",
        isLedgerReply: true,
      });

      const result = await execute(makeNode("fix_agent"), {}, ctx);

      expect(result.kind).toBe("next");
      if (result.kind === "next") {
        expect(result.output?.reviewLedger).toMatchObject({
          dispositions: [],
          declaredWrites: false,
          rejectedCount: 0,
        });
      }
      // The empty verification is stamped so finalize's guard summary can prove
      // to the publisher that the ledger looked and found nothing owed.
      expect(ctx.reviewLedger!.verification).toEqual({ accepted: [], rejected: [] });
      expect(mocks.pollPhaseUntilDone).not.toHaveBeenCalled();
      expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
    });

    it("hands the thread feed to the prompt instead of the flat comment list", async () => {
      mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
      const ctx = ledgerCtx();

      await execute(makeNode("fix_agent"), {}, ctx);

      expect(mocks.assembleFixContext).toHaveBeenCalledWith(
        expect.objectContaining({ reviewThreads: ctx.reviewLedger!.feed }),
      );
    });

    it("fails before pushing when no disposition survives verification", async () => {
      // The agent fixed something but never answered the thread. Ending green
      // here would drop the reviewer's request silently, which is the exact
      // failure the ledger exists to remove.
      mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
      const ctx = ledgerCtx();

      const result = await execute(makeNode("fix_agent"), {}, ctx);

      expect(result.kind).toBe("execution_error");
      if (result.kind === "execution_error") {
        expect(result.error.detail).toContain(
          "no disposition survived verification for T1",
        );
        expect(result.error.detail).toContain("T1 (no disposition)");
      }
      expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
    });

    it("verifies the dispositions and carries the guard summary into the push", async () => {
      mocks.parseAgentOutput.mockReturnValue({
        result: "implemented",
        summary: "patched",
        reviewThreads: [
          { alias: "T1", disposition: "actionable", reply: "restored it", evidence: null },
        ],
      });
      const ctx = ledgerCtx();

      const result = await execute(makeNode("fix_agent"), {}, ctx);

      expect(result.kind).toBe("next");
      expect(ctx.reviewLedger!.verification).toEqual({
        accepted: [
          {
            alias: "T1",
            disposition: "actionable",
            reply: "restored it",
            threadId: "d-1",
          },
        ],
        rejected: [],
      });
      expect(mocks.publishTrustedWorkspaceFromSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewLedger: expect.objectContaining({
            actionableAliases: ["T1"],
            acceptedAliases: ["T1"],
            rejectedCount: 0,
            truncated: 0,
            declaredWrites: false,
          }),
        }),
      );
    });

    it("ignores an answer aimed at a context-only thread instead of failing on it", async () => {
      // The prompt shows the awaiting-human thread as context, so answering it
      // is a confused model. Rejecting the alias would fail a run that answered
      // the one thread it actually owed.
      mocks.parseAgentOutput.mockReturnValue({
        result: "implemented",
        summary: "patched",
        reviewThreads: [
          { alias: "T1", disposition: "actionable", reply: "restored it", evidence: null },
          { alias: "T2", disposition: "question", reply: "still waiting on you", evidence: null },
        ],
      });
      const ctx = ledgerCtx();
      ctx.reviewLedger!.feed.threads.push({
        threadId: "d-2",
        alias: "T2",
        source: "human",
        resolvable: true,
        awaitingHuman: true,
        notes: [
          {
            author: "ai-workflow",
            body: "answered last run",
            createdAt: "2026-08-20T11:00:00.000Z",
            isLedgerReply: true,
          },
        ],
      });

      const result = await execute(makeNode("fix_agent"), {}, ctx);

      expect(result.kind).toBe("next");
      expect(ctx.reviewLedger!.verification?.rejected).toEqual([]);
      expect(ctx.reviewLedger!.verification?.ignoredContextAliases).toEqual(["T2"]);
    });

    it("records the sha it pushed to the PR's own repository", async () => {
      // What the run pushed is the difference between "the fix is on the branch
      // but a later block failed" and "nothing was touched". Only the failure
      // note can tell the reviewer which one happened, and only if it knows.
      mocks.parseAgentOutput.mockReturnValue({
        result: "implemented",
        summary: "patched",
        reviewThreads: [
          { alias: "T1", disposition: "actionable", reply: "restored it", evidence: null },
        ],
      });
      mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
        pushed: true,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            branchName: "blazebot/awt-1",
            defaultBranch: "main",
            pushed: true,
            pushedHead: "def456",
          },
          {
            provider: "github",
            repoPath: "acme/docs",
            branchName: "blazebot/awt-1",
            defaultBranch: "main",
            pushed: true,
            pushedHead: "sibling789",
          },
        ],
      });
      const ctx = ledgerCtx();

      await execute(makeNode("fix_agent"), {}, ctx);

      expect(ctx.pushedHeadForPr).toBe("def456");
    });

    it("leaves a run without a ledger untouched", async () => {
      mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
      const ctx = prFixCtx(makePrPayload());

      const result = await execute(makeNode("fix_agent"), {}, ctx);

      expect(result.kind).toBe("next");
      expect(result.kind === "next" && result.output).not.toHaveProperty("reviewLedger");
      expect(mocks.assembleFixContext).toHaveBeenCalledWith(
        expect.not.objectContaining({ reviewThreads: expect.anything() }),
      );
    });
  });

  it("promotes the ticket workspace before launching the agent phase", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
    const ctx = makeCtx();
    const execution = {};

    const result = await execute(makeNode("fix_agent"), {}, ctx, {}, execution);

    expect(result.kind).toBe("next");
    // The fix block ensures the workspace can accept a write before it runs.
    expect(mocks.maybePromoteTicketWorkspaceWrites).toHaveBeenCalledWith(
      ctx,
      execution,
    );
    // Promotion is awaited before the agent phase writes its input/wrapper.
    const promoteOrder =
      mocks.maybePromoteTicketWorkspaceWrites.mock.invocationCallOrder[0];
    const launchOrder = mocks.writeFiles.mock.invocationCallOrder[0];
    expect(promoteOrder).toBeLessThan(launchOrder);
  });

  it("propagates a promotion failure without launching the agent phase", async () => {
    const failure = {
      kind: "execution_error" as const,
      error: { category: "sandbox", detail: "write-scope promotion failed" },
      output: { status: "failed" },
    };
    mocks.maybePromoteTicketWorkspaceWrites.mockResolvedValueOnce(failure);
    const ctx = makeCtx();

    const result = await execute(makeNode("fix_agent"), {}, ctx);

    expect(result).toBe(failure);
    expect(mocks.setCommitGuard).not.toHaveBeenCalled();
    expect(mocks.writeFiles).not.toHaveBeenCalled();
  });

  it("runs the phase with a sanitized block id label and records usage as Fix", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
    const ctx = makeCtx();

    const result = await execute(
      makeNode("fix_agent", { instructions: "focus on CI" }, "Fix Block!"),
      {},
      ctx,
    );

    expect(mocks.artifactPaths).toHaveBeenCalledWith("fix-fix-block-");
    expect(mocks.setCommitGuard).toHaveBeenCalledWith(
      expect.anything(),
      true,
      undefined,
    );
    expect(mocks.writeFiles).toHaveBeenCalledWith([
      { path: "/tmp/fix-fix-block--requirements.md", content: Buffer.from("FIX INPUT") },
      { path: "/tmp/fix-fix-block--wrapper.sh", content: Buffer.from("#!/bin/bash") },
    ]);
    expect(mocks.assembleFixContext).toHaveBeenCalledWith(
      expect.objectContaining({ instructions: "focus on CI" }),
    );
    expect(ctx.markLaunched).toHaveBeenCalledWith("Fix Fix Block!");
    expect(mocks.pollPhaseUntilDone).toHaveBeenCalledWith(
      "sbx-1",
      "/tmp/fix-fix-block--done",
      25,
      "cmd-2",
      ctx.observeBudget,
      undefined,
    );
    expect(ctx.recordUsage).toHaveBeenCalledWith("Fix Fix Block!", usage, "claude-model");
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "fixed",
        workspaceId: "sbx-1",
        commits: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
        summary: "patched",
      },
    });
    expectOutputConformsToRegistry("fix_agent", result.output!);
  });

  it("compiles the v2 role prompt around runtime fix data before launch", async () => {
    mocks.parseAgentOutput.mockReturnValue({
      result: "implemented",
      summary: "patched",
    });
    const compileEffectivePrompt = vi.fn().mockResolvedValue({
      ok: true,
      prompt: "COMPILED FIX PROMPT",
    });

    const block = makeNode("fix_agent", {
      instructions: "Focus on the failing test",
    });
    const runtime = makeHarnessRuntime(block.id, block.type);

    await execute(
      block,
      {},
      makeCtx({
        schemaVersion: 2,
        harnessRuntimes: { [block.id]: runtime },
      }),
      {},
      { compileEffectivePrompt },
    );

    expect(mocks.assembleFixContext).toHaveBeenCalledWith(
      expect.not.objectContaining({ instructions: expect.anything() }),
    );
    expect(compileEffectivePrompt).toHaveBeenCalledWith({
      blockPrompt: "Focus on the failing test",
      runtimeData: "FIX INPUT",
      sandboxId: "sbx-1",
    });
    expect(mocks.writeFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          content: Buffer.from("COMPILED FIX PROMPT"),
        }),
      ]),
    );
  });

  it("feeds pr_trigger failed checks and review into the fix context", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented" });
    const ctx = makeCtx({
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_checks_failed",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr: makePrPayload({
          failedChecks: [{ name: "ci", conclusion: "failure", detailsUrl: "https://ci" }],
          review: { state: "changes_requested", author: "bob", body: "rename this" },
        }),
      },
    });

    await execute(makeNode("fix_agent"), {}, ctx);

    const input = mocks.assembleFixContext.mock.calls[0][0];
    expect(input.failedChecks).toEqual([
      { name: "ci", status: "completed", conclusion: "failure", logs: "Details: https://ci" },
    ]);
    expect(input.prComments).toEqual([{ author: "bob", body: "rename this", liked: false }]);
  });

  it("refuses a v2 fix when the PR ownership lookup is unknown", async () => {
    mocks.findRunPrSiblings.mockResolvedValue({ status: "unknown", reason: "database unavailable" });
    const ctx = makeCtx({
      schemaVersion: 2,
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_updated",
        subjectKey: "pr:github:acme/api#42",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "any",
        pr: makePrPayload({ prNumber: 42, repoPath: "acme/api" }),
      },
    });

    const result = await execute(makeNode("fix_agent"), {}, ctx);

    expect(result).toMatchObject({
      kind: "execution_error",
      error: { category: "provider" },
    });
    expect(JSON.stringify(result)).toContain("ownership is unknown");
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("prefers explicitly bound review feedback and avoids provider-comment duplicates", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented" });
    const ctx = makeCtx({
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr: makePrPayload({
          review: {
            state: "changes_requested",
            author: "Ambient reviewer",
            body: "Ambient feedback",
          },
        }),
      },
      repositoryContexts: [
        {
          repository: {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "workflow-owned",
          },
          prComments: [
            {
              author: "Alice",
              body: "[Review: changes requested] Please add coverage.",
              liked: false,
            },
          ],
          checkResults: [],
          hasConflicts: false,
        },
      ],
    });

    await execute(makeNode("fix_agent"), {}, ctx, {
      reviewFeedback: {
        state: "changes_requested",
        author: "Alice",
        body: "Please add coverage.",
      },
    });

    expect(mocks.assembleFixContext.mock.calls[0][0].prComments).toEqual([
      {
        author: "Alice",
        body: "[Review: changes requested] Please add coverage.",
        liked: false,
      },
    ]);
  });

  it("fails safely when explicitly bound review feedback is malformed", async () => {
    const result = await execute(makeNode("fix_agent"), {}, makeCtx(), {
      reviewFeedback: {
        state: "approved",
        author: "Alice",
        body: "Looks good",
        secret: "must-not-leak",
      },
    });

    expect(result).toEqual({
      kind: "execution_error",
      error: expect.objectContaining({
        category: "binding",
        // The internal binding label follows the operator sentence (AIW-254): an
        // explicit message is a lead, not a replacement for the detail.
        message:
          "The review feedback input must contain a valid state, author, and body. (invalid reviewFeedback binding)",
      }),
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(mocks.assembleFixContext).not.toHaveBeenCalled();
  });

  it("validates and forwards ordered internal Review Results separately", async () => {
    await execute(makeNode("fix_agent"), {}, makeCtx(), {
      reviewResults: [
        {
          status: "reviewed",
          decision: "request_changes",
          findings: [
            {
              file: "src/security.ts",
              description: "Validate the token.",
              severity: "Blocker",
            },
          ],
        },
        {
          status: "reviewed",
          decision: "approve",
          findings: [],
          feedback: "Looks good.",
        },
      ],
    });

    expect(mocks.assembleFixContext.mock.calls[0][0]).toMatchObject({
      reviewResults: [
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/security.ts",
              description: "Validate the token.",
              severity: "Blocker",
            },
          ],
        },
        {
          decision: "approve",
          findings: [],
          feedback: "Looks good.",
        },
      ],
    });
  });

  it("does not send read-only sibling findings to the fix agent", async () => {
    const block = makeNode("fix_agent");
    const pr = makePrPayload({ prNumber: 42 });
    const workspaceManifest = {
      version: 2 as const,
      repositories: [
        {
          provider: "github" as const,
          repoPath: "acme/api",
          slug: "acme__api",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: pr.headRef,
          selectedRationale: "current PR",
          access: "write" as const,
        },
        {
          provider: "gitlab" as const,
          repoPath: "acme/contracts",
          slug: "gitlab__acme__contracts",
          localPath: "/vercel/sandbox/repos/gitlab__acme__contracts",
          defaultBranch: "main",
          branchName: "main",
          selectedRationale: "sibling PR",
          access: "read" as const,
          researchBaseSha: "read-base",
        },
      ],
    };
    await execute(
      block,
      {},
      makeCtx({
        schemaVersion: 2,
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_updated",
          subjectKey: "pr:github:acme/api#42",
          ownerToken: "owner:test",
          definitionId: 1,
          definitionVersion: 1,
          scope: "workflow_owned",
          pr,
        },
        selectedRepositories: [
          { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "current PR" },
          { provider: "gitlab", repoPath: "acme/contracts", defaultBranch: "main", selectedRationale: "sibling PR" },
        ],
        workspaceManifest,
        harnessRuntimes: { [block.id]: makeHarnessRuntime(block.id, block.type) },
      }),
      {
        reviewResults: [
          {
            decision: "request_changes",
            findings: [
              { file: "src/api.ts", description: "Fix the API.", severity: "High", repo: "acme/api" },
              { file: "src/contracts.ts", description: "Fix the sibling.", severity: "Blocker", repo: "acme/contracts" },
            ],
          },
        ],
      },
    );

    expect(mocks.assembleFixContext.mock.calls[0][0].reviewResults).toEqual([
      {
        decision: "request_changes",
        findings: [
          { file: "src/api.ts", description: "Fix the API.", severity: "High", repo: "acme/api" },
        ],
      },
    ]);
    expect(mocks.restoreReadOnlyFixRepositories).toHaveBeenCalledWith(
      "sbx-1",
      workspaceManifest,
    );
  });

  it("rejects malformed internal Review Results before invoking the agent", async () => {
    const result = await execute(makeNode("fix_agent"), {}, makeCtx(), {
      reviewResults: [
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Invalid range.",
              severity: "Blocker",
              endLine: 3,
            },
          ],
        },
      ],
    });

    expect(result).toEqual({
      kind: "execution_error",
      error: expect.objectContaining({
        category: "binding",
        message:
          "reviewResults[0].findings[0].endLine requires startLine. (invalid reviewResults binding)",
      }),
    });
    expect(mocks.assembleFixContext).not.toHaveBeenCalled();
  });

  it("threads clarification history from ctx into the fix context", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented" });
    const clarifications = [
      { questions: ["Which env?"], answer: "staging", answeredBy: "alice" },
    ];

    await execute(makeNode("fix_agent"), {}, makeCtx({ clarifications }));

    const input = mocks.assembleFixContext.mock.calls[0][0];
    expect(input.ticket.clarifications).toEqual(clarifications);
  });

  it("omits clarifications from the fix context when ctx has none", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented" });

    await execute(makeNode("fix_agent"), {}, makeCtx());

    const input = mocks.assembleFixContext.mock.calls[0][0];
    expect(input.ticket.clarifications).toBeUndefined();
  });

  it("maps clarification_needed to needs_human_input", async () => {
    mocks.parseAgentOutput.mockReturnValue({
      result: "clarification_needed",
      questions: ["Which env?"],
    });

    const result = await execute(makeNode("fix_agent"), {}, makeCtx());

    expect(result).toEqual({
      kind: "needs_human_input",
      output: {
        status: "needs_human_input",
        workspaceId: "sbx-1",
        commits: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
        questions: ["Which env?"],
      },
      questions: ["Which env?"],
    });
  });

  it.each([null, [], ["", "   "]])(
    "supplies an answerable fallback when clarification questions are %j",
    async (questions) => {
      mocks.parseAgentOutput.mockReturnValue({
        result: "clarification_needed",
        questions,
      });

      const result = await execute(makeNode("fix_agent"), {}, makeCtx());

      expect(result.kind).toBe("needs_human_input");
      if (result.kind === "needs_human_input") {
        expect(result.questions).toEqual([
          "The Fix Agent needs more information. What should it use to continue?",
        ]);
        expect(result.output!.questions).toEqual(result.questions);
      }
    },
  );

  it("reports cumulative commits since the workspace baseline and conflicts resolved by Fix", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "resolved" });
    mocks.inspectFixWorkspace
      .mockResolvedValueOnce({
        commits: [{ provider: "github", repoPath: "acme/api", sha: "earlier123" }],
        unresolvedConflicts: [
          { provider: "github", repoPath: "acme/api", files: ["src/conflict.ts"] },
        ],
      })
      .mockResolvedValueOnce({
        commits: [
          { provider: "github", repoPath: "acme/api", sha: "earlier123" },
          { provider: "github", repoPath: "acme/api", sha: "fix123" },
        ],
        unresolvedConflicts: [],
      });

    const result = await execute(makeNode("fix_agent"), {}, makeCtx());

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "fixed",
        workspaceId: "sbx-1",
        commits: [
          { provider: "github", repoPath: "acme/api", sha: "earlier123" },
          { provider: "github", repoPath: "acme/api", sha: "fix123" },
        ],
        resolvedConflicts: [
          { provider: "github", repoPath: "acme/api", files: ["src/conflict.ts"] },
        ],
        unresolvedConflicts: [],
        summary: "resolved",
      },
    });
  });

  it("creates a human checkpoint instead of fixed when conflicts remain", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "attempted" });
    const unresolved = [
      { provider: "github" as const, repoPath: "acme/api", files: ["src/conflict.ts"] },
    ];
    mocks.inspectFixWorkspace
      .mockResolvedValueOnce({ commits: [], unresolvedConflicts: unresolved })
      .mockResolvedValueOnce({
        commits: [{ provider: "github", repoPath: "acme/api", sha: "partial123" }],
        unresolvedConflicts: unresolved,
      });

    const result = await execute(makeNode("fix_agent"), {}, makeCtx());

    expect(result).toEqual({
      kind: "needs_human_input",
      output: {
        status: "needs_human_input",
        workspaceId: "sbx-1",
        commits: [{ provider: "github", repoPath: "acme/api", sha: "partial123" }],
        resolvedConflicts: [],
        unresolvedConflicts: unresolved,
        questions: [
          "Merge conflicts remain in github:acme/api (src/conflict.ts). How should they be resolved before publication?",
        ],
      },
      questions: [
        "Merge conflicts remain in github:acme/api (src/conflict.ts). How should they be resolved before publication?",
      ],
    });
    expect(mocks.publishTrustedWorkspaceFromSandbox).not.toHaveBeenCalled();
  });

  it("fails the block when any repository publication reports a failure", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
    mocks.findRunPrSiblings.mockResolvedValueOnce({
      status: "none",
      runId: "published-run",
      current: {
        provider: "github",
        repoPath: "acme/api",
        id: 7,
        url: "https://github.com/acme/api/pull/7",
      },
    });
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValueOnce({
      pushed: false,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          branchName: "blazebot/awt-1",
          defaultBranch: "main",
          changed: true,
          pushed: false,
          failureKind: "push_failed",
          error: "lease rejected",
        },
      ],
    });
    const pr = makePrPayload();
    const ctx = makeCtx({
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_updated",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr,
      },
      workspaceManifest: {
        version: 2,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            slug: "acme__api",
            localPath: "/vercel/sandbox",
            defaultBranch: "main",
            branchName: pr.headRef,
            selectedRationale: "PR fix",
            access: "write",
          },
        ],
      },
    });

    const result = await execute(makeNode("fix_agent"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("lease rejected");
    }
    expect(mocks.upsertWorkflowOwnedBranch).not.toHaveBeenCalled();
  });

  it("maps a failed agent result to an execution error without output", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "failed", error: "could not fix" });

    const result = await execute(makeNode("fix_agent"), {}, makeCtx());

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toBe("could not fix");
      expect(result.output).toBeUndefined();
    }
  });

  it("maps wrapper launch setup failure to a provider protocol error", async () => {
    mocks.runCommand.mockImplementation((command) =>
      command === "chmod"
        ? {
            exitCode: 1,
            stdout: vi.fn().mockResolvedValue(""),
            stderr: vi.fn().mockResolvedValue("permission denied"),
          }
        : { cmdId: "cmd-2", exitCode: null },
    );

    const result = await execute(makeNode("fix_agent"), {}, makeCtx());

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error).toMatchObject({
        category: "provider",
        // The captured stderr now reaches the operator (AIW-254). It is quoted
        // rather than classified: "permission denied" in a local command's stderr
        // is a chmod failure, not rejected API credentials, so that curated rule
        // is excluded from captured-tail matching.
        message:
          "The current agent phase could not be completed. (permission denied)",
        diagnostic: { failureKind: "setup_failed", stderrTail: "permission denied" },
      });
    }
    expect(mocks.pollPhaseUntilDone).not.toHaveBeenCalled();
  });

  it.each(runControlErrorCases())("rethrows %s from Fix execution", async (_label, error) => {
    mocks.pollPhaseUntilDone.mockRejectedValue(error);

    await expect(execute(makeNode("fix_agent"), {}, makeCtx())).rejects.toBe(error);
  });

  it("returns a timeout execution error without publishing workspace output", async () => {
    mocks.pollPhaseUntilDone.mockResolvedValue(false);
    mocks.collectPhase.mockResolvedValue({
      stdout: "partial stdout",
      stderr: "partial stderr",
      structuredOutput: null,
      exitCode: null,
    });
    const emit = vi.fn();
    const before = {
      commits: [{ provider: "github" as const, repoPath: "acme/api", sha: "before123" }],
      unresolvedConflicts: [
        { provider: "github" as const, repoPath: "acme/api", files: ["src/old.ts"] },
      ],
    };
    const after = {
      commits: [
        { provider: "github" as const, repoPath: "acme/api", sha: "before123" },
        { provider: "github" as const, repoPath: "acme/api", sha: "partial456" },
      ],
      unresolvedConflicts: [
        { provider: "github" as const, repoPath: "acme/api", files: ["src/new.ts"] },
      ],
    };
    mocks.inspectFixWorkspace.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const block = makeNode("fix_agent");
    const result = await execute(
      block,
      {},
      makeCtx({
        schemaVersion: 2,
        workspaceManifest: {
          version: 2,
          repositories: [
            {
              provider: "gitlab",
              repoPath: "acme/contracts",
              slug: "gitlab__acme__contracts",
              localPath: "/vercel/sandbox/repos/gitlab__acme__contracts",
              defaultBranch: "main",
              branchName: "main",
              selectedRationale: "sibling PR",
              access: "read",
              researchBaseSha: "read-base",
            },
          ],
        },
        harnessRuntimes: { [block.id]: makeHarnessRuntime(block.id, block.type) },
      }),
      {},
      { observations: { emit } },
    );

    expect(result).toEqual({
      kind: "execution_error",
      error: {
        category: "timeout",
        message: "The block timed out. (fix phase timed out)",
        detail: "fix phase timed out",
      },
    });
    expect(mocks.inspectFixWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.stopPhaseCommand).toHaveBeenCalledWith("sbx-1", "cmd-2");
    expect(mocks.restoreReadOnlyFixRepositories).toHaveBeenCalledOnce();
    expect(mocks.collectPhase).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({
      kind: "log",
      value: { stream: "stderr", tail: "partial stderr" },
    });
    expect(emit).toHaveBeenLastCalledWith({
      kind: "metadata",
      value: expect.objectContaining({
        protocol: {
          outcome: "timeout",
          partialArtifacts: "captured",
        },
      }),
    });
  });

  it("restores read-only repositories when parsing the agent result fails", async () => {
    const block = makeNode("fix_agent");
    mocks.parseAgentOutputProtocol.mockReturnValueOnce({
      ok: false,
      category: "parsing",
      message: "The current agent phase returned an invalid structured response.",
      diagnostic: {
        provider: "claude",
        packageName: "@anthropic-ai/claude-code",
        cliVersion: "2.1.216",
        protocol: "claude-json-2.1.216",
        phase: "fix-blk",
        failureKind: "invalid_json",
        exitCode: 0,
      },
    });

    const result = await execute(
      block,
      {},
      makeCtx({
        schemaVersion: 2,
        workspaceManifest: {
          version: 2,
          repositories: [
            {
              provider: "gitlab",
              repoPath: "acme/contracts",
              slug: "gitlab__acme__contracts",
              localPath: "/vercel/sandbox/repos/gitlab__acme__contracts",
              defaultBranch: "main",
              branchName: "main",
              selectedRationale: "sibling PR",
              access: "read",
              researchBaseSha: "read-base",
            },
          ],
        },
        harnessRuntimes: { [block.id]: makeHarnessRuntime(block.id, block.type) },
      }),
    );

    expect(result.kind).toBe("execution_error");
    expect(mocks.stopPhaseCommand).toHaveBeenCalledWith("sbx-1", "cmd-2");
    expect(mocks.restoreReadOnlyFixRepositories).toHaveBeenCalledOnce();
  });
});
