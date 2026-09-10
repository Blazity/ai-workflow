import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, Output, type LanguageModel } from "ai";
import type { LlmProvider } from "./llm-provider.js";

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

interface LlmProviderCredentials {
  anthropicApiKey?: string;
  codexApiKey?: string;
}

export interface GenerateProviderTextInput {
  model: string;
  provider: LlmProvider;
  system?: string;
  prompt: string;
  timeoutMs?: number;
  schema?: unknown;
  credentials: LlmProviderCredentials;
}

export interface GenerateProviderTextResult {
  object?: unknown;
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null;
}

function resolveModel(
  provider: LlmProvider,
  model: string,
  credentials: LlmProviderCredentials,
): LanguageModel {
  if (provider === "codex") {
    return createOpenAI({ apiKey: credentials.codexApiKey })(model);
  }
  return createAnthropic({ apiKey: credentials.anthropicApiKey })(model);
}

/** Execute one AI SDK provider call using already-normalized transport inputs. */
export async function generateProviderText(
  input: GenerateProviderTextInput,
): Promise<GenerateProviderTextResult> {
  let timeoutMs = LLM_TIMEOUT_MS;
  if (input.timeoutMs !== undefined) {
    timeoutMs = Math.min(LLM_TIMEOUT_MS, Math.max(1, Math.floor(input.timeoutMs)));
  }
  const base = {
    model: resolveModel(input.provider, input.model, input.credentials),
    prompt: input.prompt,
    abortSignal: AbortSignal.timeout(timeoutMs),
  };
  const providerInput: typeof base & { system?: string } = { ...base };
  if (input.system !== undefined) providerInput.system = input.system;
  if (input.schema !== undefined) {
    const result = await generateText({
      ...providerInput,
      output: Output.object({ schema: jsonSchema(input.schema) }),
    });
    return {
      object: result.output,
      text: result.text,
      usage: mapUsage(result.usage),
    };
  }

  const result = await generateText(providerInput);
  return {
    text: result.text,
    usage: mapUsage(result.usage),
  };
}

function mapUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number };
}): GenerateProviderTextResult["usage"] {
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
