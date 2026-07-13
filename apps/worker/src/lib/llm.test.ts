import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateStructured } from "./llm.js";

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

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: (model: any) => mockAnthropic(model),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (opts: any) => mockCreateOpenAI(opts),
}));

vi.mock("../../env.js", () => ({ env: { CODEX_API_KEY: "test-codex-key" } }));

describe("generateStructured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("threads model/system/prompt and maps usage for the no-schema path", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "hello world",
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 3 } },
    });

    const result = await generateStructured({
      model: "claude-haiku-4-5",
      system: "you are helpful",
      prompt: "say hi",
    });

    expect(mockAnthropic).toHaveBeenCalledWith("claude-haiku-4-5");
    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg).toMatchObject({
      model: { __model: "claude-haiku-4-5" },
      system: "you are helpful",
      prompt: "say hi",
    });
    expect(callArg.output).toBeUndefined();
    expect(result).toEqual({
      text: "hello world",
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 3 },
    });
  });

  it("builds Output.object from the JSON schema string and returns the parsed object", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: '{"status":"ok"}',
      output: { status: "ok" },
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 4 },
    });

    const result = await generateStructured({
      model: "claude-opus-4-6",
      prompt: "classify",
      schema: '{"type":"object"}',
    });

    expect(mockJsonSchema).toHaveBeenCalledWith({ type: "object" });
    expect(mockOutputObject).toHaveBeenCalledWith({ schema: { __schema: { type: "object" } } });
    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.output).toEqual({ __outputObject: { schema: { __schema: { type: "object" } } } });
    // No system provided → the key is omitted entirely.
    expect("system" in callArg).toBe(false);
    expect(result.object).toEqual({ status: "ok" });
    // cachedTokens falls back to the deprecated cachedInputTokens field.
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, cachedTokens: 4 });
  });

  it("defaults every usage field to 0 when the SDK omits them", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "x", usage: {} });

    const result = await generateStructured({ model: "m", prompt: "p" });

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });

  it("propagates errors from the underlying model call", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("model exploded"));

    await expect(generateStructured({ model: "m", prompt: "p" })).rejects.toThrow(
      "model exploded",
    );
  });

  it("routes to the codex/OpenAI provider (built with CODEX_API_KEY) when provider is codex", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "hi", usage: {} });

    await generateStructured({ provider: "codex", model: "gpt-5-codex", prompt: "p" });

    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: "test-codex-key" });
    expect(mockOpenAiModel).toHaveBeenCalledWith("gpt-5-codex");
    expect(mockAnthropic).not.toHaveBeenCalled();
    expect(mockGenerateText.mock.calls[0][0].model).toEqual({ __openaiModel: "gpt-5-codex" });
  });

  it("infers the codex provider from a gpt model id when none is passed", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "hi", usage: {} });

    await generateStructured({ model: "gpt-5", prompt: "p" });

    expect(mockOpenAiModel).toHaveBeenCalledWith("gpt-5");
    expect(mockAnthropic).not.toHaveBeenCalled();
  });

  it("routes to the anthropic provider when provider is claude, overriding the model id", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "hi", usage: {} });

    await generateStructured({ provider: "claude", model: "gpt-5", prompt: "p" });

    expect(mockAnthropic).toHaveBeenCalledWith("gpt-5");
    expect(mockCreateOpenAI).not.toHaveBeenCalled();
  });
});
