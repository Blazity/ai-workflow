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
vi.mock("../../../sandbox/poll-agent.js", () => ({
  checkPhaseDone: mocks.checkPhaseDone,
  collectPhase: mocks.collectPhase,
  collectPhaseReplayDiagnostics: mocks.collectPhase,
}));
vi.mock("../../../sandbox/context.js", () => ({
  assembleFixContext: mocks.assembleFixContext,
}));
vi.mock("../../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({ writeFiles: mocks.writeFiles, runCommand: mocks.runCommand })),
  },
}));
vi.mock("../poll-phase.js", () => ({
  pollPhaseUntilDone: mocks.pollPhaseUntilDone,
  stopPhaseCommand: mocks.stopPhaseCommand,
}));
vi.mock("../../../sandbox/agents/index.js", () => ({
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
vi.mock("../prepare-workspace/execute.js", () => ({
  ensureWorkspace: mocks.ensureWorkspace,
  maybePromoteTicketWorkspaceWrites: mocks.maybePromoteTicketWorkspaceWrites,
}));
vi.mock("../agent-sandbox.js", () => ({
  prepareHarnessAgentInvocationStep: mocks.prepareHarnessAgentInvocation,
}));
vi.mock("../fix-workspace-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fix-workspace-state.js")>()),
  inspectFixWorkspace: mocks.inspectFixWorkspace,
  restoreReadOnlyFixRepositories: mocks.restoreReadOnlyFixRepositories,
}));
vi.mock("../../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../../db/queries/run-pr-siblings.js", () => ({
  findRunPrSiblings: mocks.findRunPrSiblings,
}));
vi.mock("../../../sandbox/trusted-workspace-publisher.js", () => ({
  publishTrustedWorkspaceFromSandbox: (...args: any[]) =>
    mocks.publishTrustedWorkspaceFromSandbox(...args),
}));
vi.mock("../../../db/queries/workflow-owned-branches.js", () => ({
  findWorkflowOwnedPullRequestIdentity: (...args: any[]) =>
    mocks.findWorkflowOwnedPullRequestIdentity(...args),
  upsertWorkflowOwnedBranch: (...args: any[]) =>
    mocks.upsertWorkflowOwnedBranch(...args),
  recordWorkflowOwnedPullRequestPublishedHead: (...args: any[]) =>
    mocks.recordWorkflowOwnedPullRequestPublishedHead(...args),
}));

import { execute } from "./execute.js";
import { manifest } from "./manifest.js";
import {
  makeCtx,
  makeHarnessRuntime,
  makeNode,
  makePrPayload,
} from "../support/test-support.js";

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
    const parsed = manifest.paramsSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.maxMinutes).toBe(25);
    expect(manifest.paramsSchema.safeParse({ maxMinutes: 4 }).success).toBe(false);
    expect(manifest.paramsSchema.safeParse({ maxMinutes: 61 }).success).toBe(false);
    expect(manifest.paramsSchema.safeParse({ instructions: "x".repeat(4001) }).success).toBe(false);
    expect(manifest.paramsSchema.safeParse({ provider: "codex", model: "gpt-5" }).success).toBe(true);
    expect(manifest.paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
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

  it("refuses a v2 fix when the PR ownership lookup is unknown", async () => {
    mocks.findRunPrSiblings.mockResolvedValue({ status: "unknown", reason: "database unavailable" });
    const ctx = makeCtx({
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
