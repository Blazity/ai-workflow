import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  checkPhaseDone: vi.fn(),
  collectPhase: vi.fn(),
  setCommitGuard: vi.fn(),
  artifactPaths: vi.fn(),
  buildPhaseScript: vi.fn(),
  parseStructuredObjectProtocol: vi.fn(),
  extractUsage: vi.fn(),
  writeFiles: vi.fn(),
  runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
  sandboxGet: vi.fn(),
  ensureAgentSandbox: vi.fn(),
  prepareHarnessAgentInvocation: vi.fn(),
  pollPhaseUntilDone: vi.fn().mockResolvedValue(true),
}));

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  sleep: mocks.sleep,
}));
vi.mock("../../steps/sandbox-poll-agent.js", () => ({
  checkPhaseDone: mocks.checkPhaseDone,
  collectPhase: mocks.collectPhase,
  collectPhaseReplayDiagnostics: mocks.collectPhase,
}));
vi.mock("../../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../poll-phase.js", () => ({ pollPhaseUntilDone: mocks.pollPhaseUntilDone }));
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
    parseStructuredObjectProtocol: mocks.parseStructuredObjectProtocol,
    extractUsage: mocks.extractUsage,
  })),
}));
vi.mock("../agent-sandbox.js", () => ({
  ensureAgentSandbox: mocks.ensureAgentSandbox,
  prepareHarnessAgentInvocationStep: mocks.prepareHarnessAgentInvocation,
}));

import { execute } from "./execute.js";
import { manifest } from "./manifest.js";
import { makeCtx, makeHarnessRuntime, makeNode } from "../support/test-support.js";

function pathsFor(phase: string) {
  return {
    wrapper: `/tmp/${phase}-wrapper.sh`,
    input: `/tmp/${phase}-requirements.md`,
    stdout: `/tmp/${phase}-stdout.txt`,
    stderr: `/tmp/${phase}-stderr.txt`,
    exitCode: `/tmp/${phase}-exit-code`,
    sentinel: `/tmp/${phase}-done`,
    structuredOutput: `/tmp/${phase}-result.json`,
  };
}

describe("generic_agent paramsSchema", () => {
  it("allows a binding-only prompt and rejects unknown keys", () => {
    expect(manifest.paramsSchema.parse({ prompt: "do things" })).toMatchObject({
      prompt: "do things",
      workspaceMode: "none",
    });
    expect(manifest.paramsSchema.safeParse({ prompt: "" }).success).toBe(true);
    expect(manifest.paramsSchema.safeParse({}).success).toBe(true);
    expect(
      manifest.paramsSchema.safeParse({ prompt: "p", provider: "codex", model: "m", outputSchema: "{}" })
        .success,
    ).toBe(true);
    expect(manifest.paramsSchema.safeParse({ prompt: "p", extra: 1 }).success).toBe(false);
  });
});

describe("generic_agent execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandboxGet.mockResolvedValue({
      writeFiles: mocks.writeFiles,
      runCommand: mocks.runCommand,
    });
    mocks.artifactPaths.mockImplementation((phase: string) => pathsFor(phase));
    mocks.buildPhaseScript.mockReturnValue("#!/bin/bash");
    mocks.checkPhaseDone.mockResolvedValue(true);
    mocks.extractUsage.mockReturnValue(null);
    mocks.parseStructuredObjectProtocol.mockImplementation((artifacts) => {
      const source = artifacts.structuredOutput ?? artifacts.stdout;
      try {
        const envelope = JSON.parse(source);
        return {
          ok: true,
          value: envelope?.type === "result" ? envelope.structured_output : envelope,
        };
      } catch {
        return {
          ok: false,
          category: "parsing",
          message: "The current agent phase returned an invalid structured response.",
          diagnostic: {
            provider: "claude",
            packageName: "@anthropic-ai/claude-code",
            cliVersion: "2.1.216",
            protocol: "claude-json-2.1.216",
            phase: "agent-test",
            failureKind: "invalid_json",
            exitCode: 0,
            detail: "Agent output was not valid JSON.",
          },
        };
      }
    });
    mocks.ensureAgentSandbox.mockResolvedValue("scratch-new");
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
        : { cmdId: "cmd-1", exitCode: null },
    );
    mocks.pollPhaseUntilDone.mockResolvedValue(true);
  });

  it("uses the v2 effective-prompt compiler immediately before launch", async () => {
    mocks.collectPhase.mockResolvedValue({
      stdout: "",
      stderr: "",
      structuredOutput: JSON.stringify({
        status: "ok",
        body: "continued",
        questions: null,
        error: null,
      }),
      exitCode: 0,
    });
    const compileEffectivePrompt = vi.fn().mockResolvedValue({
      ok: true,
      prompt: "COMPILED EFFECTIVE PROMPT",
    });

    const block = makeNode("generic_agent", {
      prompt: "Authored prompt",
      workspaceMode: "none",
    });
    const runtime = makeHarnessRuntime(block.id, block.type, {
      workspaceMode: "none",
    });
    mocks.ensureAgentSandbox.mockResolvedValueOnce("scratch-1");

    await execute(
      block,
      {},
      makeCtx({
        sandboxId: null,
        harnessRuntimes: { [block.id]: runtime },
      } as never),
      { plan: "Bound plan", count: 2 },
      {
        clarificationAnswer: "Use Redis",
        compileEffectivePrompt,
      },
    );

    expect(compileEffectivePrompt).toHaveBeenCalledWith({
      blockPrompt: "Authored prompt",
      runtimeData:
        'Resolved inputs:\n{\n  "plan": "Bound plan",\n  "count": 2\n}\n\nHuman clarification answer:\nUse Redis',
      sandboxId: "scratch-1",
    });
    expect(mocks.writeFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          content: Buffer.from("COMPILED EFFECTIVE PROMPT"),
        }),
      ]),
    );
  });

  it("requests isolated scratch sandboxes for parallel same-manifest v2 fan-out", async () => {
    mocks.collectPhase.mockResolvedValue({
      stdout: "",
      stderr: "",
      structuredOutput: JSON.stringify({
        status: "ok",
        body: "done",
        questions: null,
        error: null,
      }),
      exitCode: 0,
    });
    const firstBlock = makeNode(
      "generic_agent",
      { prompt: "First", workspaceMode: "none" },
      "first",
    );
    const secondBlock = makeNode(
      "generic_agent",
      { prompt: "Second", workspaceMode: "none" },
      "second",
    );
    const firstRuntime = makeHarnessRuntime(
      firstBlock.id,
      firstBlock.type,
      { workspaceMode: "none" },
    );
    const secondRuntime = makeHarnessRuntime(
      secondBlock.id,
      secondBlock.type,
      { workspaceMode: "none" },
    );
    expect(firstRuntime.manifestHash).toBe(secondRuntime.manifestHash);
    mocks.ensureAgentSandbox.mockReset();
    mocks.ensureAgentSandbox.mockImplementation(
      async (
        _ctx,
        _kind,
        _model,
        options: { runtime?: { safeManifest: { nodeId: string } } },
      ) =>
        options.runtime?.safeManifest.nodeId === firstBlock.id
          ? "scratch-1"
          : "scratch-2",
    );
    const ctx = makeCtx({
      sandboxId: null,
      harnessRuntimes: {
        [firstBlock.id]: firstRuntime,
        [secondBlock.id]: secondRuntime,
      },
    });

    await execute(
      firstBlock,
      {},
      ctx,
      {},
      { attempt: 1, agentArtifactKey: "1" },
    );
    await execute(
      secondBlock,
      {},
      ctx,
      {},
      { attempt: 1, agentArtifactKey: "2" },
    );
    expect(mocks.ensureAgentSandbox).toHaveBeenNthCalledWith(
      1,
      ctx,
      "claude",
      "claude-model",
      { runtime: firstRuntime, reuse: false },
    );
    expect(mocks.ensureAgentSandbox).toHaveBeenNthCalledWith(
      2,
      ctx,
      "claude",
      "claude-model",
      { runtime: secondRuntime, reuse: false },
    );
    expect(
      new Set(
        mocks.sandboxGet.mock.calls.map(
          ([input]) => (input as { sandboxId: string }).sandboxId,
        ),
      ),
    ).toEqual(new Set(["scratch-1", "scratch-2"]));
  });

  it("uses the active v2 invocation budget for polling and usage", async () => {
    const usage = {
      cost_usd: 0.25,
      tokens: { input: 20, cached_input: 2, output: 3 },
      duration_ms: 100,
      duration_api_ms: 90,
      num_turns: 1,
    };
    mocks.collectPhase.mockResolvedValue({
      stdout: "",
      stderr: "",
      structuredOutput: JSON.stringify({
        status: "ok",
        body: "done",
        questions: null,
        error: null,
      }),
      exitCode: 0,
    });
    mocks.extractUsage.mockReturnValue(usage);
    const block = makeNode(
      "generic_agent",
      { prompt: "Work", workspaceMode: "none" },
      "budgeted",
    );
    const runtime = makeHarnessRuntime(
      block.id,
      block.type,
      { workspaceMode: "none" },
    );
    const observeBudget = vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 10_000,
    });
    const recordBudgetUsage = vi.fn();
    const ctx = makeCtx({
      sandboxId: null,
      harnessRuntimes: { [block.id]: runtime },
    });

    await execute(
      block,
      {},
      ctx,
      {},
      {
        attempt: 1,
        agentArtifactKey: "1",
        observeBudget,
        recordBudgetUsage,
      },
    );

    expect(mocks.pollPhaseUntilDone).toHaveBeenCalledWith(
      "scratch-new",
      expect.any(String),
      25,
      "cmd-1",
      observeBudget,
      undefined,
    );
    expect(recordBudgetUsage).toHaveBeenCalledWith(
      usage,
      runtime.manifest.model.id,
    );
  });

  it("keeps colliding valid v2 ids distinct in artifact paths and usage labels", async () => {
    mocks.collectPhase.mockResolvedValue({
      stdout: "",
      stderr: "",
      structuredOutput: JSON.stringify({
        status: "ok",
        body: "done",
        questions: null,
        error: null,
      }),
      exitCode: 0,
    });
    const firstBlock = makeNode(
      "generic_agent",
      { prompt: "p" },
      "Blk_One",
    );
    const secondBlock = makeNode(
      "generic_agent",
      { prompt: "p" },
      "blk-one",
    );
    const ctx = makeCtx({
      harnessRuntimes: {
        [firstBlock.id]: makeHarnessRuntime(
          firstBlock.id,
          firstBlock.type,
        ),
        [secondBlock.id]: makeHarnessRuntime(
          secondBlock.id,
          secondBlock.type,
        ),
      },
    });

    await execute(
      firstBlock,
      {},
      ctx,
      {},
      { attempt: 1, agentArtifactKey: "2" },
    );
    await execute(
      secondBlock,
      {},
      ctx,
      {},
      { attempt: 1, agentArtifactKey: "3" },
    );

    expect(mocks.artifactPaths.mock.calls).toEqual([
      ["agent-blk-one-v2-2-a1"],
      ["agent-blk-one-v2-3-a1"],
    ]);
    expect(ctx.markLaunched).toHaveBeenCalledTimes(2);
    expect(ctx.markLaunched).toHaveBeenNthCalledWith(1, "Agent Blk_One", 1);
    expect(ctx.markLaunched).toHaveBeenNthCalledWith(2, "Agent blk-one", 1);
    expect(ctx.recordUsage).toHaveBeenCalledTimes(2);
    expect(ctx.recordUsage).toHaveBeenNthCalledWith(
      1,
      "Agent Blk_One",
      null,
      "claude",
      "claude-model",
      1,
    );
    expect(ctx.recordUsage).toHaveBeenNthCalledWith(
      2,
      "Agent blk-one",
      null,
      "claude",
      "claude-model",
      1,
    );
  });
});
