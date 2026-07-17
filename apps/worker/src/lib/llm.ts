import { generateText, Output, jsonSchema } from "ai";
import type { LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../../env.js";

export type LlmProvider = "claude" | "codex";

/**
 * Hard bound on a single provider call, mirroring the agent blocks' MAX_MINUTES
 * phase cap (generic-agent.ts): a module-level default, not a block param. The
 * callers set maxRetries = 0, so without this a hung provider has no bound at
 * all. Generous against real latency (a slow reasoning call is well under it)
 * and far below the 25-minute agent phase cap.
 *
 * Must stay under the platform's function timeout (300s by default, and this
 * project sets no maxDuration). At exactly 300s the platform kill races the
 * abort, so the block would surface an opaque platform error instead of the
 * clean call_llm failure this bound exists to produce.
 */
const LLM_TIMEOUT_MS = 4 * 60 * 1000;

export interface GenerateStructuredInput {
  model: string;
  /**
   * Which AI SDK provider to route to. When omitted it is inferred from the
   * model id (claude prefix to claude, gpt or o-series to codex) and falls back
   * to claude.
   */
  provider?: LlmProvider;
  system?: string;
  prompt: string;
  /**
   * JSON-schema string describing the desired object. When present the model is
   * asked to return a matching object; when absent, plain text is generated.
   */
  schema?: string;
}

/** Best-effort provider guess from a model id when none was passed explicitly. */
export function inferProvider(model: string): LlmProvider | undefined {
  const id = model.toLowerCase();
  if (id.startsWith("claude") || id.startsWith("anthropic")) return "claude";
  if (id.startsWith("gpt") || /^o[0-9]/.test(id) || id.includes("codex")) return "codex";
  return undefined;
}

/** Build the AI SDK model object for the resolved provider. */
function resolveModel(provider: LlmProvider, model: string): LanguageModel {
  if (provider === "codex") {
    // Codex is the OpenAI-compatible API reached with CODEX_API_KEY, the same
    // credential the sandbox agent adapter and the model listing use.
    const openai = createOpenAI({ apiKey: env.CODEX_API_KEY });
    return openai(model);
  }
  return anthropic(model);
}

export interface GenerateStructuredResult {
  /** Parsed object matching `schema`. Absent when no schema was requested. */
  object?: unknown;
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

/**
 * Thin wrapper over the ai SDK's `generateText` that centralizes the
 * structured-vs-text branch and normalizes token usage into a stable shape.
 * Extracted from the post-PR-gate code-hygiene step so new block executors can
 * reuse it without re-deriving the Output.object / jsonSchema plumbing.
 */
export async function generateStructured(
  input: GenerateStructuredInput,
): Promise<GenerateStructuredResult> {
  const { model, provider, system, prompt, schema } = input;
  const effectiveProvider = provider ?? inferProvider(model) ?? "claude";
  const base = {
    model: resolveModel(effectiveProvider, model),
    ...(system !== undefined ? { system } : {}),
    prompt,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  };

  if (schema) {
    const result = await generateText({
      ...base,
      output: Output.object({ schema: jsonSchema(JSON.parse(schema)) }),
    });
    return { object: result.output, text: result.text, usage: mapUsage(result.usage) };
  }

  const result = await generateText(base);
  return { text: result.text, usage: mapUsage(result.usage) };
}

function mapUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
}): GenerateStructuredResult["usage"] {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedTokens: usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0,
  };
}
