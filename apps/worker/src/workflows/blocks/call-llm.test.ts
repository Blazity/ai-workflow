import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateStructured: vi.fn(),
}));

vi.mock("../../lib/llm.js", () => ({
  generateStructured: mocks.generateStructured,
}));

import { execute, paramsSchema } from "./call-llm.js";
import { makeCtx, makeNode } from "./test-support.js";

describe("call_llm paramsSchema", () => {
  it("requires a prompt, defaults the model, and rejects unknown keys", () => {
    const parsed = paramsSchema.safeParse({ prompt: "hi" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.model).toBe("claude-haiku-4-5");
    expect(paramsSchema.safeParse({}).success).toBe(false);
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
    expect(result.output).toEqual({ status: "ok", output: "answer" });
    expect(mocks.generateStructured).toHaveBeenCalledWith({
      provider: "claude",
      model: "claude-haiku-4-5",
      prompt: "hi",
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

    expect(result.output).toEqual({ status: "ok", output: { answer: 42 } });
    expect(mocks.generateStructured).toHaveBeenCalledWith({
      model: "claude-opus-4",
      prompt: "hi",
      system: "be terse",
      schema: '{"type":"object"}',
    });
  });

  it("fails on an unparseable outputSchema without calling the LLM", async () => {
    const result = await execute(
      makeNode("call_llm", { prompt: "hi", outputSchema: "{nope" }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("invalid outputSchema");
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("maps LLM errors to a failed result", async () => {
    mocks.generateStructured.mockRejectedValue(new Error("api down"));

    const result = await execute(makeNode("call_llm", { prompt: "hi" }), {}, makeCtx());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("api down");
  });
});
