import { z } from "zod";
import type { JsonValue } from "@shared/contracts";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    prompt: z.string().min(1),
    system: z.string().optional(),
    model: z.string().trim().max(200).default("claude-haiku-4-5"),
    outputSchema: z.string().optional(),
  })
  .strict();

const DEFAULT_MODEL = "claude-haiku-4-5";

interface CallLlmStepResult {
  object: unknown;
  hasObject: boolean;
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  durationMs: number;
}

async function blockCallLlmGenerateStep(input: {
  model: string;
  system?: string;
  prompt: string;
  schema?: string;
}): Promise<CallLlmStepResult> {
  "use step";
  const { generateStructured } = await import("../../lib/llm.js");
  const startedAt = Date.now();
  const result = await generateStructured(input);
  return {
    object: result.object ?? null,
    hasObject: result.object !== undefined,
    text: result.text,
    usage: result.usage,
    durationMs: Date.now() - startedAt,
  };
}
blockCallLlmGenerateStep.maxRetries = 0;

/**
 * call_llm: one in-process Anthropic call via lib/llm.ts generateStructured
 * (no sandbox involved). With an outputSchema the parsed object is returned,
 * otherwise plain text. Usage is recorded under the "LLM <blockId>" label.
 */
export const execute: BlockExecuteFn = async (block, _steps, ctx): Promise<BlockExecutionResult> => {
  const schema =
    typeof block.params.outputSchema === "string" && block.params.outputSchema.trim().length > 0
      ? block.params.outputSchema
      : undefined;
  if (schema !== undefined) {
    try {
      JSON.parse(schema);
    } catch {
      return { kind: "failed", output: { status: "failed" }, reason: "invalid outputSchema" };
    }
  }

  const prompt = typeof block.params.prompt === "string" ? block.params.prompt : "";
  if (prompt.length === 0) {
    return { kind: "failed", output: { status: "failed" }, reason: "call_llm requires a prompt" };
  }
  const model =
    typeof block.params.model === "string" && block.params.model.trim().length > 0
      ? block.params.model.trim()
      : DEFAULT_MODEL;
  const system = typeof block.params.system === "string" ? block.params.system : undefined;

  try {
    const result = await blockCallLlmGenerateStep({
      model,
      prompt,
      ...(system !== undefined ? { system } : {}),
      ...(schema !== undefined ? { schema } : {}),
    });
    ctx.recordUsage(
      `LLM ${block.id}`,
      {
        cost_usd: null,
        tokens: {
          input: result.usage.inputTokens,
          cached_input: result.usage.cachedTokens,
          output: result.usage.outputTokens,
        },
        duration_ms: result.durationMs,
        duration_api_ms: result.durationMs,
        num_turns: 1,
      },
      model,
    );

    const output =
      schema !== undefined && result.hasObject ? (result.object as JsonValue) : result.text;
    return { kind: "next", output: { status: "ok", output } };
  } catch (err) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
