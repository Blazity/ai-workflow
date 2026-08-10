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
  prepareHarnessAgentInvocation: vi.fn(),
  pollPhaseUntilDone: vi.fn().mockResolvedValue(true),
  findRunPrSiblings: vi.fn(),
  publishTrustedWorkspaceFromSandbox: vi.fn(),
  findWorkflowOwnedPullRequestIdentity: vi.fn(),
  upsertWorkflowOwnedBranch: vi.fn(),
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
vi.mock("./poll-phase.js", () => ({ pollPhaseUntilDone: mocks.pollPhaseUntilDone }));
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
}));

import { execute, paramsSchema } from "./fix-agent.js";
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
    mocks.publishTrustedWorkspaceFromSandbox.mockResolvedValue({
      pushed: true,
      repositories: [],
    });
    mocks.findWorkflowOwnedPullRequestIdentity.mockResolvedValue(undefined);
    mocks.upsertWorkflowOwnedBranch.mockResolvedValue(undefined);
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
        message:
          "The review feedback input must contain a valid state, author, and body.",
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
          "reviewResults[0].findings[0].endLine requires startLine.",
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
        message: "The current agent phase could not be completed.",
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

    const result = await execute(
      makeNode("fix_agent"),
      {},
      makeCtx(),
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
});
