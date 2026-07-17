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
  extractUsage: vi.fn(),
  writeFiles: vi.fn(),
  runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
  ensureWorkspace: vi.fn(),
  inspectFixWorkspace: vi.fn(),
}));

vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("../../sandbox/poll-agent.js", () => ({
  checkPhaseDone: mocks.checkPhaseDone,
  collectPhase: mocks.collectPhase,
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
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: vi.fn(() => ({
    setCommitGuard: mocks.setCommitGuard,
    artifactPaths: mocks.artifactPaths,
    buildPhaseScript: mocks.buildPhaseScript,
    parseAgentOutput: mocks.parseAgentOutput,
    extractUsage: mocks.extractUsage,
  })),
}));
vi.mock("./prepare-workspace.js", () => ({
  ensureWorkspace: mocks.ensureWorkspace,
}));
vi.mock("./fix-workspace-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fix-workspace-state.js")>()),
  inspectFixWorkspace: mocks.inspectFixWorkspace,
}));

import { execute, paramsSchema } from "./fix-agent.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeNode,
  makePrPayload,
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
    mocks.assembleFixContext.mockReturnValue("FIX INPUT");
    mocks.artifactPaths.mockImplementation((phase: string) => pathsFor(phase));
    mocks.buildPhaseScript.mockReturnValue("#!/bin/bash");
    mocks.checkPhaseDone.mockResolvedValue(true);
    mocks.collectPhase.mockResolvedValue({ raw: "raw", structured: null });
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
  });

  it("implicitly ensures a workspace when none is attached", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
    const result = await execute(makeNode("fix_agent"), {}, makeCtx({ sandboxId: null }));

    expect(mocks.ensureWorkspace).toHaveBeenCalledTimes(1);
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

  it("runs the phase with a sanitized block id label and records usage as Fix", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented", summary: "patched" });
    const ctx = makeCtx();

    const result = await execute(
      makeNode("fix_agent", { instructions: "focus on CI" }, "Fix Block!"),
      {},
      ctx,
    );

    expect(mocks.artifactPaths).toHaveBeenCalledWith("fix-fix-block-");
    expect(mocks.setCommitGuard).toHaveBeenCalledWith(expect.anything(), true);
    expect(mocks.writeFiles).toHaveBeenCalledWith([
      { path: "/tmp/fix-fix-block--requirements.md", content: Buffer.from("FIX INPUT") },
      { path: "/tmp/fix-fix-block--wrapper.sh", content: Buffer.from("#!/bin/bash") },
    ]);
    expect(mocks.assembleFixContext).toHaveBeenCalledWith(
      expect.objectContaining({ instructions: "focus on CI" }),
    );
    expect(ctx.markLaunched).toHaveBeenCalledWith("Fix Fix Block!");
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
    expectOutputConformsToRegistry("fix_agent", result.output);
  });

  it("feeds pr_trigger failed checks and review into the fix context", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "implemented" });
    const ctx = makeCtx({
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_checks_failed",
        ticketKey: "AWT-1",
        definitionId: 1,
        definitionVersion: 1,
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
  });

  it("maps a failed agent result to kind failed", async () => {
    mocks.parseAgentOutput.mockReturnValue({ result: "failed", error: "could not fix" });

    const result = await execute(makeNode("fix_agent"), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("could not fix");
      expect(result.output).toEqual({
        status: "failed",
        workspaceId: "sbx-1",
        commits: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
      });
    }
  });

  it("reports the post-termination workspace state when the phase times out", async () => {
    mocks.checkPhaseDone.mockResolvedValue("stopped");
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

    const result = await execute(makeNode("fix_agent"), {}, makeCtx());

    expect(result).toEqual({
      kind: "failed",
      output: {
        status: "failed",
        workspaceId: "sbx-1",
        commits: after.commits,
        resolvedConflicts: [
          { provider: "github", repoPath: "acme/api", files: ["src/old.ts"] },
        ],
        unresolvedConflicts: after.unresolvedConflicts,
      },
      reason: "fix phase timed out",
    });
    expect(mocks.inspectFixWorkspace).toHaveBeenCalledTimes(2);
    expect(mocks.collectPhase).not.toHaveBeenCalled();
  });
});
