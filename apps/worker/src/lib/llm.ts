import { generateText, Output, jsonSchema } from "ai";
import type { LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../../env.js";
import {
  jsonSchemaForProvider,
  normalizeJsonSchemaProviderOutput,
  parseJsonSchema202012,
} from "../workflow-definition/json-schema.js";
import { resolveLlmProvider, type LlmProvider } from "./llm-provider.js";

export { inferProvider } from "./llm-provider.js";
export type { LlmProvider } from "./llm-provider.js";

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
  /** Optional caller budget; the module safety timeout remains the upper bound. */
  timeoutMs?: number;
  /**
   * JSON-schema string describing the desired object. When present the model is
   * asked to return a matching object; when absent, plain text is generated.
   */
  schema?: string;
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
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null;
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
  const timeoutMs = Math.min(
    LLM_TIMEOUT_MS,
    input.timeoutMs === undefined ? LLM_TIMEOUT_MS : Math.max(1, Math.floor(input.timeoutMs)),
  );
  const effectiveProvider = resolveLlmProvider(model, provider);
  const base = {
    model: resolveModel(effectiveProvider, model),
    ...(system !== undefined ? { system } : {}),
    prompt,
    abortSignal: AbortSignal.timeout(timeoutMs),
  };

  if (schema) {
    const parsed = parseJsonSchema202012(schema, { legacyCompatibility: true });
    if (!parsed.ok) throw new Error(parsed.issues[0]?.message ?? "outputSchema is invalid.");
    const providerSchema = jsonSchemaForProvider(parsed.schema, effectiveProvider);
    const result = await generateText({
      ...base,
      output: Output.object({ schema: jsonSchema(providerSchema) }),
    });
    return {
      object: normalizeJsonSchemaProviderOutput(
        parsed.schema,
        effectiveProvider,
        result.output,
      ),
      text: result.text,
      usage: mapUsage(result.usage),
    };
  }

  const result = await generateText(base);
  return { text: result.text, usage: mapUsage(result.usage) };
}

function mapUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number };
}): GenerateStructuredResult["usage"] {
  if (
    !usage ||
    typeof usage.inputTokens !== "number" ||
    typeof usage.outputTokens !== "number"
  ) {
    return null;
  }
  const cachedTokens = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
  const inputTokens = usage.inputTokenDetails?.noCacheTokens
    ?? Math.max(0, usage.inputTokens - cachedTokens);
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens,
  };
}
