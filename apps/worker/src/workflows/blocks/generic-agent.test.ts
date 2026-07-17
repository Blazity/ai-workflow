import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  checkPhaseDone: vi.fn(),
  collectPhase: vi.fn(),
  setCommitGuard: vi.fn(),
  artifactPaths: vi.fn(),
  buildPhaseScript: vi.fn(),
  extractUsage: vi.fn(),
  writeFiles: vi.fn(),
  runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
  sandboxGet: vi.fn(),
  ensureAgentSandbox: vi.fn(),
  pollPhaseUntilDone: vi.fn().mockResolvedValue(true),
}));

vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("../../sandbox/poll-agent.js", () => ({
  checkPhaseDone: mocks.checkPhaseDone,
  collectPhase: mocks.collectPhase,
}));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("./poll-phase.js", () => ({ pollPhaseUntilDone: mocks.pollPhaseUntilDone }));
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: vi.fn(() => ({
    setCommitGuard: mocks.setCommitGuard,
    artifactPaths: mocks.artifactPaths,
    buildPhaseScript: mocks.buildPhaseScript,
    extractUsage: mocks.extractUsage,
  })),
}));
vi.mock("./agent-sandbox.js", () => ({
  ensureAgentSandbox: mocks.ensureAgentSandbox,
}));

import { GENERIC_SCHEMA } from "../../sandbox/agents/types.js";
import { execute, paramsSchema } from "./generic-agent.js";
import { expectOutputConformsToRegistry, makeCtx, makeNode } from "./test-support.js";

function pathsFor(phase: string) {
  return {
    wrapper: `/tmp/${phase}-wrapper.sh`,
    input: `/tmp/${phase}-requirements.md`,
    stdout: `/tmp/${phase}-stdout.txt`,
    stderr: `/tmp/${phase}-stderr.txt`,
    sentinel: `/tmp/${phase}-done`,
    structuredOutput: `/tmp/${phase}-result.json`,
  };
}

describe("generic_agent paramsSchema", () => {
  it("requires a prompt and rejects unknown keys", () => {
    expect(paramsSchema.parse({ prompt: "do things" })).toMatchObject({
      prompt: "do things",
      workspaceMode: "none",
    });
    expect(paramsSchema.safeParse({ prompt: "" }).success).toBe(false);
    expect(paramsSchema.safeParse({}).success).toBe(false);
    expect(
      paramsSchema.safeParse({ prompt: "p", provider: "codex", model: "m", outputSchema: "{}" })
        .success,
    ).toBe(true);
    expect(paramsSchema.safeParse({ prompt: "p", extra: 1 }).success).toBe(false);
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
    mocks.ensureAgentSandbox.mockResolvedValue("scratch-new");
    mocks.runCommand.mockResolvedValue({ cmdId: "cmd-1", exitCode: null });
    mocks.pollPhaseUntilDone.mockResolvedValue(true);
  });

  it("fails on an unparseable outputSchema before touching the sandbox", async () => {
    const result = await execute(
      makeNode("generic_agent", { prompt: "p", outputSchema: "{nope" }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("invalid outputSchema");
    expect(mocks.sandboxGet).not.toHaveBeenCalled();
  });

  it("fails without a workspace in read_write mode", async () => {
    const result = await execute(
      makeNode("generic_agent", { prompt: "p", workspaceMode: "read_write" }),
      {},
      makeCtx({ sandboxId: null }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("no workspace");
  });

  it("uses an agent-only scratch sandbox in none mode", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "planned", questions: null, error: null }),
    });
    const ctx = makeCtx({
      sandboxId: null,
      agentSandboxIds: { claude: "scratch-1" },
    } as never);

    const result = await execute(
      makeNode("generic_agent", { prompt: "Plan only", workspaceMode: "none" }),
      {},
      ctx,
    );

    expect(mocks.sandboxGet).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "scratch-1" }),
    );
    expect(result).toEqual({ kind: "next", output: { status: "ok", body: "planned" } });
  });

  it("adds the clarification answer to the rerun prompt", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "continued", questions: null, error: null }),
    });
    const ctx = makeCtx({
      sandboxId: null,
      agentSandboxIds: { claude: "scratch-1" },
    } as never);

    await (execute as any)(
      makeNode("generic_agent", { prompt: "Choose a cache", workspaceMode: "none" }),
      {},
      ctx,
      {},
      { clarificationAnswer: "Use Redis" },
    );

    const inputWrite = mocks.writeFiles.mock.calls
      .flatMap(([files]) => files)
      .find((file: { path: string }) => file.path.endsWith("requirements.md"));
    expect(inputWrite.content.toString("utf8")).toContain("Human clarification answer:\nUse Redis");
  });

  it("provisions agent-only scratch on demand in none mode", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "planned", questions: null, error: null }),
    });
    const ctx = makeCtx({ sandboxId: null, agentSandboxIds: {} } as never);

    const result = await execute(
      makeNode("generic_agent", { prompt: "Plan only", workspaceMode: "none" }),
      {},
      ctx,
    );

    expect(mocks.ensureAgentSandbox).toHaveBeenCalledWith(ctx, "claude", "claude-model");
    expect(mocks.sandboxGet).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "scratch-new" }),
    );
    expect(result.kind).toBe("next");
  });

  it("maps agent-only scratch provisioning failures to a failed block", async () => {
    mocks.ensureAgentSandbox.mockRejectedValueOnce(new Error("sandbox unavailable"));

    const result = await execute(
      makeNode("generic_agent", { prompt: "Plan only", workspaceMode: "none" }),
      {},
      makeCtx({ sandboxId: null, agentSandboxIds: {} } as never),
    );

    expect(result).toEqual({
      kind: "failed",
      output: { status: "failed" },
      reason: "sandbox unavailable",
    });
  });

  it("writes the prompt verbatim, uses GENERIC_SCHEMA, and maps ok output", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "done", questions: null, error: null }),
    });
    const ctx = makeCtx();

    const result = await execute(
      makeNode("generic_agent", { prompt: "Verbatim prompt." }, "My Agent"),
      {},
      ctx,
    );

    expect(mocks.artifactPaths).toHaveBeenCalledWith("agent-my-agent");
    // Explicit, not inherited from whatever agent block ran before this one.
    expect(mocks.setCommitGuard).toHaveBeenCalledWith(expect.anything(), true);
    expect(mocks.buildPhaseScript).toHaveBeenCalledWith(
      expect.objectContaining({ jsonSchema: GENERIC_SCHEMA }),
    );
    expect(mocks.writeFiles).toHaveBeenCalledWith([
      { path: "/tmp/agent-my-agent-requirements.md", content: Buffer.from("Verbatim prompt.") },
      { path: "/tmp/agent-my-agent-wrapper.sh", content: Buffer.from("#!/bin/bash") },
    ]);
    expect(ctx.markLaunched).toHaveBeenCalledWith("Agent My Agent");
    expect(mocks.pollPhaseUntilDone).toHaveBeenCalledWith(
      "sbx-1",
      "/tmp/agent-my-agent-done",
      25,
      "cmd-1",
      ctx.observeBudget,
    );
    expect(ctx.recordUsage).toHaveBeenCalledWith("Agent My Agent", null, "claude-model");
    expect(result).toEqual({ kind: "next", output: { status: "ok", body: "done" } });
  });

  it("emits the guaranteed body field when an unstructured success body is empty", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "", questions: null, error: null }),
    });

    const result = await execute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({ kind: "next", output: { status: "ok", body: "" } });
  });

  it("prefers a resolved prompt over the static param", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "done", questions: null, error: null }),
    });

    await execute(
      makeNode("generic_agent", { prompt: "static" }),
      {},
      makeCtx(),
      { prompt: "bound" },
    );

    expect(mocks.writeFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: Buffer.from("bound") }),
      ]),
    );
  });

  it("keeps the telemetry label unique per raw block id while sanitizing the artifact path", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "done", questions: null, error: null }),
    });
    const ctx = makeCtx();

    // "Blk.One" and "blk-one" both sanitize to "blk-one"; the raw id keeps the
    // telemetry keys distinct so usage attribution does not collide.
    await execute(makeNode("generic_agent", { prompt: "p" }, "Blk.One"), {}, ctx);

    expect(mocks.artifactPaths).toHaveBeenCalledWith("agent-blk-one");
    expect(ctx.markLaunched).toHaveBeenCalledWith("Agent Blk.One");
    expect(ctx.recordUsage).toHaveBeenCalledWith("Agent Blk.One", null, "claude-model");
  });

  it("maps needs_input output to needs_human_input", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({
        status: "needs_input",
        body: "",
        questions: ["Which region?"],
        error: null,
      }),
    });

    const result = await execute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({
      kind: "needs_human_input",
      output: { status: "needs_human_input", questions: ["Which region?"] },
      questions: ["Which region?"],
    });
  });

  it("threads suggestedAnswers through needs_input output", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({
        status: "needs_input",
        body: "",
        questions: ["Which region?"],
        suggestedAnswers: ["us-east-1", "eu-west-1"],
        error: null,
      }),
    });

    const result = await execute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({
      kind: "needs_human_input",
      output: {
        status: "needs_human_input",
        questions: ["Which region?"],
        suggestedAnswers: ["us-east-1", "eu-west-1"],
      },
      questions: ["Which region?"],
      suggestedAnswers: ["us-east-1", "eu-west-1"],
    });
  });

  it("maps failed output to kind failed with the reported error", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "failed", body: "", questions: null, error: "broke" }),
    });

    const result = await execute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("broke");
  });

  it("wraps custom-schema output as ok data", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ answer: 42 }),
    });

    const result = await execute(
      makeNode("generic_agent", { prompt: "p", outputSchema: '{"type":"object"}' }),
      {},
      makeCtx(),
    );

    expect(mocks.buildPhaseScript).toHaveBeenCalledWith(
      expect.objectContaining({ jsonSchema: '{"type":"object"}' }),
    );
    expect(result).toEqual({ kind: "next", output: { status: "ok", data: { answer: 42 } } });
  });

  it("accepts null when the declared custom schema requires null", async () => {
    mocks.collectPhase.mockResolvedValue({ raw: "", structured: "null" });
    const node = makeNode("generic_agent", {
      prompt: "p",
      outputSchema: '{"type":"null"}',
    });

    const result = await execute(node, {}, makeCtx());

    expect(result).toEqual({ kind: "next", output: { status: "ok", data: null } });
    expectOutputConformsToRegistry("generic_agent", result.output, node.params);
  });

  it("fails when custom-schema output is unparseable", async () => {
    mocks.collectPhase.mockResolvedValue({ raw: "gibberish", structured: "not json" });

    const result = await execute(
      makeNode("generic_agent", { prompt: "p", outputSchema: '{"type":"object"}' }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("agent output did not match the requested schema");
    }
  });

  it("parses a claude result envelope from raw output", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: JSON.stringify({
        type: "result",
        structured_output: { status: "ok", body: "from envelope", questions: null, error: null },
      }),
      structured: null,
    });

    const result = await execute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({
      kind: "next",
      output: { status: "ok", body: "from envelope" },
    });
  });

  it("fails when the phase times out", async () => {
    mocks.pollPhaseUntilDone.mockResolvedValue(false);

    const result = await execute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("agent phase timed out");
  }, 15000);
});
