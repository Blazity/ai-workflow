import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateStructured: vi.fn(),
}));

vi.mock("../../lib/llm.js", () => ({
  generateStructured: mocks.generateStructured,
}));

import { execute, paramsSchema, resolveCallLlmTarget } from "./call-llm.js";
import { makeCtx, makeNode, runControlErrorCases } from "./test-support.js";

describe("call_llm paramsSchema", () => {
  it("allows a binding-only prompt, leaves the model unset by default, and rejects unknown keys", () => {
    const parsed = paramsSchema.safeParse({ prompt: "hi" });
    expect(parsed.success).toBe(true);
    // No baked model default: the executor resolves it from provider/run default,
    // so a codex-only deployment never falls back to a Claude model.
    if (parsed.success) expect(parsed.data.model).toBeUndefined();
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ prompt: "hi", extra: 1 }).success).toBe(false);
  });

  it("accepts a claude/codex provider and rejects any other value", () => {
    expect(paramsSchema.safeParse({ prompt: "hi", provider: "codex" }).success).toBe(true);
    expect(paramsSchema.safeParse({ prompt: "hi", provider: "claude" }).success).toBe(true);
    expect(paramsSchema.safeParse({ prompt: "hi", provider: "gemini" }).success).toBe(false);
  });
});

describe("call_llm execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text output and records usage under LLM <blockId>", async () => {
    mocks.generateStructured.mockResolvedValue({
      text: "answer",
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 2 },
    });
    const ctx = makeCtx();

    const result = await execute(makeNode("call_llm", { prompt: "hi" }, "llm-1"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(result.output!).toEqual({ status: "ok", output: "answer" });
    expect(mocks.generateStructured).toHaveBeenCalledWith({
      provider: "claude",
      model: "claude-haiku-4-5",
      prompt: "hi",
      timeoutMs: 1_800_000,
    });
    expect(ctx.recordUsage).toHaveBeenCalledWith(
      "LLM llm-1",
      expect.objectContaining({
        cost_usd: null,
        tokens: { input: 10, cached_input: 2, output: 5 },
        num_turns: 1,
      }),
      "claude-haiku-4-5",
    );
    expect(ctx.markLaunched).toHaveBeenCalledWith("LLM llm-1");
  });

  it("records unknown usage instead of manufacturing zero tokens", async () => {
    mocks.generateStructured.mockResolvedValue({ text: "answer", usage: null });
    const ctx = makeCtx();

    await execute(makeNode("call_llm", { prompt: "hi" }, "llm-unknown"), {}, ctx);

    expect(ctx.recordUsage).toHaveBeenCalledWith("LLM llm-unknown", null, "claude-haiku-4-5");
  });

  it("caps the provider call to the remaining run duration", async () => {
    mocks.generateStructured.mockResolvedValue({
      text: "answer",
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });
    const ctx = makeCtx({
      observeBudget: vi.fn().mockResolvedValue({
        check: { status: "ok" },
        remainingDurationMs: 1_234,
      }),
    });

    await execute(makeNode("call_llm", { prompt: "hi" }), {}, ctx);

    expect(mocks.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_234 }),
    );
  });

  it("does not call the provider when the run budget is already exhausted", async () => {
    const failure = {
      status: "budget_exceeded" as const,
      metric: "duration" as const,
      limit: 100,
      consumed: 100,
      reason: "budget_exceeded: duration 100 reached limit 100 before more work",
    };
    const ctx = makeCtx({
      observeBudget: vi.fn().mockResolvedValue({ check: failure, remainingDurationMs: 0 }),
    });

    await expect(execute(makeNode("call_llm", { prompt: "hi" }), {}, ctx)).rejects.toMatchObject({
      name: "RunBudgetError",
      failure,
    });
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("classifies a remaining-duration abort as a deterministic budget failure", async () => {
    const failure = {
      status: "budget_exceeded" as const,
      metric: "duration" as const,
      limit: 100,
      consumed: 101,
      reason: "budget_exceeded: duration 101 exceeds limit 100",
    };
    mocks.generateStructured.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const ctx = makeCtx({
      observeBudget: vi
        .fn()
        .mockResolvedValueOnce({ check: { status: "ok" }, remainingDurationMs: 10 })
        .mockResolvedValueOnce({ check: failure, remainingDurationMs: 0 }),
    });

    await expect(execute(makeNode("call_llm", { prompt: "hi" }), {}, ctx)).rejects.toMatchObject({
      name: "RunBudgetError",
      failure,
    });
  });

  it("prefers resolved prompt and system inputs over static params", async () => {
    mocks.generateStructured.mockResolvedValue({
      text: "answer",
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });

    await execute(
      makeNode("call_llm", { prompt: "static", system: "static system" }),
      {},
      makeCtx(),
      { prompt: "bound", system: "bound system" },
    );

    expect(mocks.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "bound", system: "bound system" }),
    );
  });

  it("resolves the codex provider and its default model on a codex deployment", async () => {
    mocks.generateStructured.mockResolvedValue({
      text: "answer",
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });
    const ctx = makeCtx({ runDefaultKind: "codex" });

    const result = await execute(makeNode("call_llm", { prompt: "hi" }, "llm-2"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(mocks.generateStructured).toHaveBeenCalledWith({
      provider: "codex",
      model: "codex-model",
      prompt: "hi",
      timeoutMs: 1_800_000,
    });
    expect(ctx.recordUsage).toHaveBeenCalledWith("LLM llm-2", expect.anything(), "codex-model");
  });

  it("honors an explicit provider param alongside a model id", async () => {
    mocks.generateStructured.mockResolvedValue({
      text: "answer",
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });

    await execute(
      makeNode("call_llm", { prompt: "hi", provider: "codex", model: "gpt-5" }),
      {},
      makeCtx(),
    );

    expect(mocks.generateStructured).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-5",
      prompt: "hi",
      timeoutMs: 1_800_000,
    });
  });

  it("returns the parsed object when an outputSchema is set", async () => {
    mocks.generateStructured.mockResolvedValue({
      object: { answer: 42 },
      text: "{}",
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });

    const result = await execute(
      makeNode("call_llm", {
        prompt: "hi",
        system: "be terse",
        model: "claude-opus-4",
        outputSchema: '{"type":"object"}',
      }),
      {},
      makeCtx(),
    );

    expect(result.output!).toEqual({ status: "ok", output: { answer: 42 } });
    expect(mocks.generateStructured).toHaveBeenCalledWith({
      model: "claude-opus-4",
      prompt: "hi",
      system: "be terse",
      schema: '{"type":"object"}',
      timeoutMs: 1_800_000,
    });
  });

  it("preserves null when the declared output schema requires null", async () => {
    mocks.generateStructured.mockResolvedValue({
      object: null,
      text: "null",
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });

    const result = await execute(
      makeNode("call_llm", { prompt: "p", outputSchema: '{"type":"null"}' }),
      {},
      makeCtx(),
    );

    expect(result).toEqual({ kind: "next", output: { status: "ok", output: null } });
  });

  it("fails on an unparseable outputSchema without calling the LLM", async () => {
    const result = await execute(
      makeNode("call_llm", { prompt: "hi", outputSchema: "{nope" }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("invalid outputSchema");
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("maps LLM errors to a failed result", async () => {
    mocks.generateStructured.mockRejectedValue(new Error("api down"));
    const ctx = makeCtx();

    const result = await execute(makeNode("call_llm", { prompt: "hi" }), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("api down");
    expect(ctx.markLaunched).toHaveBeenCalledWith("LLM blk");
    expect(ctx.recordUsage).toHaveBeenCalledWith("LLM blk", null, "claude-haiku-4-5");
  });

  it.each(runControlErrorCases())("rethrows %s from the LLM call", async (_label, error) => {
    mocks.generateStructured.mockRejectedValue(error);

    await expect(
      execute(makeNode("call_llm", { prompt: "hi" }), {}, makeCtx()),
    ).rejects.toBe(error);
  });

  it("fails closed before a failure edge when a capped provider error has no usage", async () => {
    mocks.generateStructured.mockRejectedValue(new Error("api down"));
    let usageWasMarkedUnknown = false;
    const failure = {
      status: "budget_unverifiable" as const,
      metric: "tokens" as const,
      limit: 100,
      consumed: null,
      reason: "budget_unverifiable: token usage is unavailable",
    };
    const ctx = makeCtx({
      recordUsage: vi.fn((_label, usage) => {
        usageWasMarkedUnknown = usage === null;
      }),
      observeBudget: vi.fn(async () =>
        usageWasMarkedUnknown
          ? { check: failure, remainingDurationMs: 1_000 }
          : { check: { status: "ok" as const }, remainingDurationMs: 1_000 },
      ),
    });

    await expect(
      execute(makeNode("call_llm", { prompt: "hi" }, "capped"), {}, ctx),
    ).rejects.toMatchObject({ name: "RunBudgetError", failure });

    expect(ctx.markLaunched).toHaveBeenCalledWith("LLM capped");
    expect(ctx.recordUsage).toHaveBeenCalledWith("LLM capped", null, "claude-haiku-4-5");
  });

  it("keeps a provider timeout as a normal block failure while run budget remains", async () => {
    mocks.generateStructured.mockRejectedValue(new DOMException("provider timed out", "TimeoutError"));
    const ctx = makeCtx();

    const result = await execute(makeNode("call_llm", { prompt: "hi" }), {}, ctx);

    expect(result).toEqual({
      kind: "execution_error",
      error: {
        category: "provider",
        message: "An external service could not complete this block. (provider timed out)",
        detail: "provider timed out",
      },
    });
    expect(ctx.recordUsage).toHaveBeenCalledWith("LLM blk", null, "claude-haiku-4-5");
  });
});

describe("resolveCallLlmTarget", () => {
  it("uses the same model resolution for execution and price prefetch", () => {
    expect(
      resolveCallLlmTarget({}, "codex", { claude: "claude-default", codex: "codex-default" }),
    ).toEqual({ provider: "codex", model: "codex-default" });
    expect(
      resolveCallLlmTarget(
        { model: "gpt-5" },
        "claude",
        { claude: "claude-default", codex: "codex-default" },
      ),
    ).toEqual({ provider: undefined, model: "gpt-5" });
  });
});
