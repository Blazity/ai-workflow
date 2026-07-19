import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/llm + call_llm harness: mock the low-level ai SDK, the provider factories,
// and env, then exercise the REAL generateStructured / inferProvider. call_llm's
// executor calls the real generateStructured (which cannot be both mocked here
// and real for the llm tests), so routing is asserted on the SDK mocks and on
// ctx.recordUsage rather than on a generateStructured spy.
const mockGenerateText = vi.fn();
const mockJsonSchema = vi.fn((s: unknown) => ({ __schema: s }));
const mockOutputObject = vi.fn((cfg: unknown) => ({ __outputObject: cfg }));
const mockAnthropic = vi.fn((model: string) => ({ __model: model }));
const mockOpenAiModel = vi.fn((model: string) => ({ __openaiModel: model }));
const mockCreateOpenAI = vi.fn((_opts: unknown) => mockOpenAiModel);

vi.mock("ai", () => ({
  generateText: (config: any) => mockGenerateText(config),
  Output: { object: (cfg: any) => mockOutputObject(cfg) },
  jsonSchema: (s: any) => mockJsonSchema(s),
}));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: (model: any) => mockAnthropic(model) }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: (opts: any) => mockCreateOpenAI(opts) }));
vi.mock("../../../env.js", () => ({ env: { CODEX_API_KEY: "test-codex-key" } }));

// generic_agent harness: mock the sandbox/agent plumbing. Disjoint from the llm
// mocks above, so both harnesses coexist in one file.
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
  createAgentAdapter: vi.fn(),
}));

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  sleep: mocks.sleep,
}));
vi.mock("../../sandbox/poll-agent.js", () => ({
  checkPhaseDone: mocks.checkPhaseDone,
  collectPhase: mocks.collectPhase,
}));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../../sandbox/agents/index.js", () => ({ createAgentAdapter: mocks.createAgentAdapter }));

import { generateStructured, inferProvider } from "../../lib/llm.js";
import { requiredAgentKinds } from "../../workflow-definition/resolve-agent.js";
import { execute as callLlmExecute, paramsSchema as callLlmParams } from "./call-llm.js";
import { execute as genericExecute } from "./generic-agent.js";
import { makeCtx, makeNode } from "./test-support.js";

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

describe("lib/llm inferProvider", () => {
  it("maps an anthropic* prefix (bedrock ids) to claude", () => {
    expect(inferProvider("anthropic.claude-3")).toBe("claude");
    expect(inferProvider("anthropic.claude-3-sonnet")).toBe("claude");
  });

  it("maps the o-series (/^o[0-9]/) to codex", () => {
    expect(inferProvider("o1")).toBe("codex");
    expect(inferProvider("o3-mini")).toBe("codex");
  });

  it("maps an id containing 'codex' without a gpt/o prefix to codex", () => {
    expect(inferProvider("team-codex-model")).toBe("codex");
    expect(inferProvider("my-codex-v2")).toBe("codex");
  });

  it("returns undefined for an unknown id", () => {
    expect(inferProvider("llama-3")).toBeUndefined();
    expect(inferProvider("mistral")).toBeUndefined();
  });
});

describe("lib/llm generateStructured routing and usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes an anthropic* id to the anthropic provider", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "x", usage: {} });

    await generateStructured({ model: "anthropic.claude-3", prompt: "p" });

    expect(mockAnthropic).toHaveBeenCalledWith("anthropic.claude-3");
    expect(mockCreateOpenAI).not.toHaveBeenCalled();
  });

  it("routes an o-series id to the codex/OpenAI provider", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "x", usage: {} });

    await generateStructured({ model: "o3-mini", prompt: "p" });

    expect(mockOpenAiModel).toHaveBeenCalledWith("o3-mini");
    expect(mockAnthropic).not.toHaveBeenCalled();
  });

  it("falls back to claude/anthropic for an unknown id", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "x", usage: {} });

    await generateStructured({ model: "llama-3", prompt: "p" });

    expect(mockAnthropic).toHaveBeenCalledWith("llama-3");
    expect(mockCreateOpenAI).not.toHaveBeenCalled();
  });

  it("prefers inputTokenDetails.cacheReadTokens over cachedInputTokens", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "x",
      usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 9, inputTokenDetails: { cacheReadTokens: 2 } },
    });

    const result = await generateStructured({ model: "m", prompt: "p" });

    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, cachedTokens: 2 });
  });

  it("forwards both the schema output and the system on the schema branch", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "{}", output: {}, usage: {} });

    await generateStructured({ model: "m", system: "s", prompt: "p", schema: '{"type":"object"}' });

    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.output).toBeDefined();
    expect(callArg.system).toBe("s");
    expect(mockJsonSchema).toHaveBeenCalledWith({ type: "object" });
  });
});

describe("call_llm paramsSchema", () => {
  it("allows the static prompt to be omitted when a typed binding will supply it", () => {
    expect(callLlmParams.safeParse({}).success).toBe(true);
    expect(callLlmParams.safeParse({ prompt: "" }).success).toBe(true);
  });

  it("rejects a model with illegal chars or longer than 200 chars", () => {
    expect(callLlmParams.safeParse({ prompt: "p", model: "bad model!" }).success).toBe(false);
    expect(callLlmParams.safeParse({ prompt: "p", model: "a".repeat(201) }).success).toBe(false);
    expect(callLlmParams.safeParse({ prompt: "p", model: "gpt-4.1" }).success).toBe(true);
  });
});

describe("call_llm execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a no-model call to the codex default on a codex deployment", async () => {
    // Schema-parsed params no longer inject a Claude model default, so with no
    // model set the executor resolves the run default kind (codex) and its model.
    const params = callLlmParams.parse({ prompt: "hi" });
    mockGenerateText.mockResolvedValueOnce({ text: "x", usage: {} });
    const ctx = makeCtx({ runDefaultKind: "codex" });

    await callLlmExecute(makeNode("call_llm", params, "llm-1"), {}, ctx);

    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: "test-codex-key" });
    expect(mockOpenAiModel).toHaveBeenCalledWith("codex-model");
    expect(mockAnthropic).not.toHaveBeenCalled();
    expect(ctx.recordUsage).toHaveBeenCalledWith("LLM llm-1", null, "codex-model");
  });

  it("sends the codex default model to the codex endpoint when provider is codex", async () => {
    const params = callLlmParams.parse({ prompt: "hi", provider: "codex" });
    mockGenerateText.mockResolvedValueOnce({ text: "x", usage: {} });
    const ctx = makeCtx();

    await callLlmExecute(makeNode("call_llm", params, "llm-2"), {}, ctx);

    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: "test-codex-key" });
    expect(mockOpenAiModel).toHaveBeenCalledWith("codex-model");
    expect(mockAnthropic).not.toHaveBeenCalled();
    expect(ctx.recordUsage).toHaveBeenCalledWith("LLM llm-2", null, "codex-model");
  });

  it("fails when a schema is set but the provider returns no structured object", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "fallback", usage: {} });

    const result = await callLlmExecute(
      makeNode("call_llm", { prompt: "hi", outputSchema: '{"type":"object"}' }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("LLM output did not match the requested schema");
    }
  });

  it("accepts a Call LLM value that conforms to its declared schema", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "", output: { answer: 42 }, usage: {} });
    const outputSchema =
      '{"type":"object","properties":{"answer":{"type":"number"}},"required":["answer"],"additionalProperties":false}';

    const result = await callLlmExecute(
      makeNode("call_llm", { prompt: "hi", outputSchema }),
      {},
      makeCtx(),
    );

    expect(result).toEqual({ kind: "next", output: { status: "ok", output: { answer: 42 } } });
  });

  it("fails when a Call LLM value has the wrong declared shape", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "", output: { answer: "forty-two" }, usage: {} });
    const outputSchema =
      '{"type":"object","properties":{"answer":{"type":"number"}},"required":["answer"],"additionalProperties":false}';

    const result = await callLlmExecute(
      makeNode("call_llm", { prompt: "hi", outputSchema }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("LLM output did not match the requested schema");
    }
  });

  it("treats a whitespace-only outputSchema as no schema", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "plain", usage: {} });

    const result = await callLlmExecute(
      makeNode("call_llm", { prompt: "hi", outputSchema: "   " }),
      {},
      makeCtx(),
    );

    expect(mockOutputObject).not.toHaveBeenCalled();
    expect(mockGenerateText.mock.calls[0][0].output).toBeUndefined();
    expect(result.output).toEqual({ status: "ok", output: "plain" });
  });

  it("fails on an empty prompt without calling the LLM", async () => {
    const result = await callLlmExecute(makeNode("call_llm", { prompt: "" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("call_llm requires a prompt");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe("generic_agent execute output branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandboxGet.mockResolvedValue({ writeFiles: mocks.writeFiles, runCommand: mocks.runCommand });
    mocks.runCommand.mockResolvedValue({ exitCode: 0 });
    mocks.writeFiles.mockResolvedValue(undefined);
    mocks.artifactPaths.mockImplementation((phase: string) => pathsFor(phase));
    mocks.buildPhaseScript.mockReturnValue("#!/bin/bash");
    mocks.checkPhaseDone.mockResolvedValue(true);
    mocks.extractUsage.mockReturnValue(null);
    mocks.sleep.mockResolvedValue(undefined);
    mocks.createAgentAdapter.mockReturnValue({
      setCommitGuard: mocks.setCommitGuard,
      artifactPaths: mocks.artifactPaths,
      buildPhaseScript: mocks.buildPhaseScript,
      extractUsage: mocks.extractUsage,
    });
  });

  it("fails on an empty prompt before touching the sandbox", async () => {
    const result = await genericExecute(makeNode("generic_agent", { prompt: "" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("generic_agent requires a prompt");
    expect(mocks.sandboxGet).not.toHaveBeenCalled();
  });

  it("falls back to the body when needs_input has an empty questions array", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "needs_input", body: "clarify scope", questions: [], error: null }),
    });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({
      kind: "needs_human_input",
      output: { status: "needs_human_input", questions: ["clarify scope"] },
      questions: ["clarify scope"],
    });
  });

  it("falls back to the body when needs_input questions are all whitespace", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "needs_input", body: "clarify scope", questions: ["  ", ""], error: null }),
    });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    if (result.kind === "needs_human_input") expect(result.questions).toEqual(["clarify scope"]);
    else throw new Error("expected needs_human_input");
  });

  it("uses body.slice(0,500) as the reason when failed has no error", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "failed", body: "X".repeat(600), questions: null, error: null }),
    });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("X".repeat(500));
  });

  it("keeps the registry-required body key when ok output is empty", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "", questions: null, error: null }),
    });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({ kind: "next", output: { status: "completed", body: "" } });
  });

  it("truncates an ok body longer than 4000 chars", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "a".repeat(5000), questions: null, error: null }),
    });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    if (result.kind === "next") expect((result.output as unknown as { body: string }).body).toHaveLength(4000);
    else throw new Error("expected next");
  });

  it("rejects literal null because Generic Agent declares top-level object fields", async () => {
    mocks.collectPhase.mockResolvedValue({ raw: "", structured: "null" });

    const result = await genericExecute(
      makeNode("generic_agent", { prompt: "p", outputSchema: '{"type":"null"}' }),
      {},
      makeCtx(),
    );

    expect(result).toEqual({
      kind: "failed",
      output: { status: "failed" },
      reason: "invalid outputSchema: outputSchema must declare an object for Generic Agent.",
    });
  });

  it("fails when a default-schema object has the wrong shape", async () => {
    mocks.collectPhase.mockResolvedValue({ raw: "", structured: JSON.stringify({ foo: 1 }) });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("agent output was not structured JSON");
  });

  it("fails when no object can be extracted at all", async () => {
    mocks.collectPhase.mockResolvedValue({ raw: "noise", structured: null });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("agent output was not structured JSON");
  });

  it("fails fast when the phase is stopped early", async () => {
    mocks.checkPhaseDone.mockResolvedValue("stopped");

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("agent phase timed out");
    // Loop exits on the first poll rather than running to the timeout cap.
    expect(mocks.sleep).toHaveBeenCalledTimes(1);
  });

  it("flips adapter kind and model when provider is codex", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "done", questions: null, error: null }),
    });
    const ctx = makeCtx();

    await genericExecute(makeNode("generic_agent", { prompt: "p", provider: "codex" }, "A"), {}, ctx);

    expect(mocks.createAgentAdapter).toHaveBeenCalledWith("codex");
    expect(ctx.recordUsage).toHaveBeenCalledWith("Agent A", null, "codex-model");
  });

  it("records a non-null usage object from the adapter", async () => {
    const usage = { cost_usd: null, tokens: { input: 1, cached_input: 0, output: 2 }, num_turns: 1 };
    mocks.extractUsage.mockReturnValue(usage);
    mocks.collectPhase.mockResolvedValue({
      raw: "",
      structured: JSON.stringify({ status: "ok", body: "done", questions: null, error: null }),
    });
    const ctx = makeCtx();

    await genericExecute(makeNode("generic_agent", { prompt: "p" }, "A"), {}, ctx);

    expect(ctx.recordUsage).toHaveBeenCalledWith("Agent A", usage, "claude-model");
  });

  it("maps a mid-flow error to failed with the error message", async () => {
    mocks.writeFiles.mockRejectedValue(new Error("disk full"));

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("disk full");
  });
});

describe("generic_agent extractStructuredObject via execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandboxGet.mockResolvedValue({ writeFiles: mocks.writeFiles, runCommand: mocks.runCommand });
    mocks.runCommand.mockResolvedValue({ exitCode: 0 });
    mocks.writeFiles.mockResolvedValue(undefined);
    mocks.artifactPaths.mockImplementation((phase: string) => pathsFor(phase));
    mocks.buildPhaseScript.mockReturnValue("#!/bin/bash");
    mocks.checkPhaseDone.mockResolvedValue(true);
    mocks.extractUsage.mockReturnValue(null);
    mocks.sleep.mockResolvedValue(undefined);
    mocks.createAgentAdapter.mockReturnValue({
      setCommitGuard: mocks.setCommitGuard,
      artifactPaths: mocks.artifactPaths,
      buildPhaseScript: mocks.buildPhaseScript,
      extractUsage: mocks.extractUsage,
    });
  });

  it("parses a result envelope whose result is a JSON string", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: JSON.stringify({ type: "result", result: '{"status":"ok","body":"b"}' }),
      structured: null,
    });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({ kind: "next", output: { status: "completed", body: "b" } });
  });

  it("skips an envelope with null structured_output and a non-string result", async () => {
    const plain = JSON.stringify({ status: "ok", body: "later", questions: null, error: null });
    const envelope = JSON.stringify({ type: "result", structured_output: null, result: 123 });
    mocks.collectPhase.mockResolvedValue({ raw: `${plain}\n${envelope}`, structured: null });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({ kind: "next", output: { status: "completed", body: "later" } });
  });

  it("chooses the last valid JSON line from multiline raw output", async () => {
    const raw = 'junk\n{"status":"ok","body":"first"}\n{"status":"ok","body":"last"}';
    mocks.collectPhase.mockResolvedValue({ raw, structured: null });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({ kind: "next", output: { status: "completed", body: "last" } });
  });

  it("returns a plain non-envelope object as-is", async () => {
    mocks.collectPhase.mockResolvedValue({
      raw: JSON.stringify({ status: "ok", body: "plain", questions: null, error: null }),
      structured: null,
    });

    const result = await genericExecute(makeNode("generic_agent", { prompt: "p" }), {}, makeCtx());

    expect(result).toEqual({ kind: "next", output: { status: "completed", body: "plain" } });
  });
});

describe("resolve-agent requiredAgentKinds", () => {
  it("treats an invalid provider as the default, adding no new kind", () => {
    expect(requiredAgentKinds([{ type: "planning_agent", params: { provider: "gpt" } }], "claude")).toEqual([
      "claude",
    ]);
  });
});
