import { z } from "zod";
import type { JsonValue } from "@shared/contracts";
import { validateBlockOutputForDefinition } from "../../workflow-definition/block-registry.js";
import {
  parseJsonSchema202012,
  validateJsonSchemaValue,
  type ParsedJsonSchema,
} from "../../workflow-definition/json-schema.js";
import { RunBudgetError } from "../run-budget.js";
import { isRunControlError } from "../run-control-error.js";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    prompt: z.string().optional(),
    system: z.string().optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:\/-]+$/).optional(),
    provider: z.enum(["claude", "codex"]).optional(),
    outputSchema: z.string().optional(),
  })
  .strict();

const DEFAULT_MODEL = "claude-haiku-4-5";

export function resolveCallLlmTarget(
  params: Record<string, unknown>,
  runDefaultKind: "claude" | "codex",
  defaults: { claude: string; codex: string },
): { provider: "claude" | "codex" | undefined; model: string } {
  const explicitModel =
    typeof params.model === "string" && params.model.trim().length > 0
      ? params.model.trim()
      : undefined;
  const explicitProvider =
    params.provider === "claude" || params.provider === "codex" ? params.provider : undefined;
  if (explicitModel !== undefined) {
    return { provider: explicitProvider, model: explicitModel };
  }
  const provider = explicitProvider ?? runDefaultKind;
  return {
    provider,
    model: provider === "codex" ? defaults.codex : DEFAULT_MODEL,
  };
}

interface CallLlmStepResult {
  object: unknown;
  hasObject: boolean;
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null;
  durationMs: number;
}

async function blockCallLlmGenerateStep(input: {
  model: string;
  provider?: "claude" | "codex";
  system?: string;
  prompt: string;
  schema?: string;
  timeoutMs: number;
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
 * call_llm: one in-process LLM call via lib/llm.ts generateStructured (no
 * sandbox involved). The provider is the block's provider param, else inferred
 * from an explicit model id, else the run default kind; the model is the block's
 * model param, else the claude-haiku-4-5 default for claude / CODEX_MODEL for
 * codex. With an outputSchema the parsed object is returned, otherwise plain
 * text. Usage is recorded under the "LLM <blockId>" label.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
): Promise<BlockExecutionResult> => {
  const schema =
    typeof block.params.outputSchema === "string" && block.params.outputSchema.trim().length > 0
      ? block.params.outputSchema
      : undefined;
  let parsedSchema: Extract<ParsedJsonSchema, { ok: true }> | undefined;
  if (schema !== undefined) {
    const parsed = parseJsonSchema202012(schema, { legacyCompatibility: true });
    if (!parsed.ok) {
      return executionError("invalid outputSchema", { category: "schema" });
    }
    parsedSchema = parsed;
  }

  const prompt =
    typeof resolvedInputs.prompt === "string"
      ? resolvedInputs.prompt
      : typeof block.params.prompt === "string"
        ? block.params.prompt
        : "";
  if (prompt.length === 0) {
    return executionError("call_llm requires a prompt", { category: "binding" });
  }
  // With an explicit model, pass it through and let generateStructured infer the
  // provider from the id unless one is set. Without a model, default to the run
  // provider and its model (claude keeps the historical haiku default).
  const { provider, model } = resolveCallLlmTarget(
    block.params,
    ctx.runDefaultKind,
    ctx.defaults,
  );
  const system =
    typeof resolvedInputs.system === "string"
      ? resolvedInputs.system
      : typeof block.params.system === "string"
        ? block.params.system
        : undefined;
  const budget = await ctx.observeBudget();
  if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
  const timeoutMs = Math.max(1, Math.floor(budget.remainingDurationMs));
  const usageLabel = `LLM ${block.id}`;
  ctx.markLaunched(usageLabel);

  try {
    const result = await blockCallLlmGenerateStep({
      model,
      ...(provider !== undefined ? { provider } : {}),
      prompt,
      timeoutMs,
      ...(system !== undefined ? { system } : {}),
      ...(schema !== undefined ? { schema } : {}),
    });
    ctx.recordUsage(
      usageLabel,
      result.usage
        ? {
            cost_usd: null,
            tokens: {
              input: result.usage.inputTokens,
              cached_input: result.usage.cachedTokens,
              output: result.usage.outputTokens,
            },
            duration_ms: result.durationMs,
            duration_api_ms: result.durationMs,
            num_turns: 1,
          }
        : null,
      model,
    );

    if (schema !== undefined) {
      if (!result.hasObject) {
        return executionError("LLM output did not match the requested schema", {
          category: "schema",
        });
      }
      if (
        parsedSchema === undefined ||
        validateJsonSchemaValue(parsedSchema.schema, result.object).length > 0
      ) {
        return executionError("LLM output did not match the requested schema", {
          category: "schema",
        });
      }
      const output = { status: "ok", output: result.object as JsonValue } as const;
      if (
        validateBlockOutputForDefinition(block.type, block.params, output, {
          requireNormalOutput: true,
        }).length > 0
      ) {
        return executionError("LLM output did not match the requested schema", {
          category: "schema",
        });
      }
      return { kind: "next", output };
    }
    return { kind: "next", output: { status: "ok", output: result.text } };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    ctx.recordUsage(usageLabel, null, model);
    const after = await ctx.observeBudget();
    if (after.check.status !== "ok") throw new RunBudgetError(after.check);
    if (after.remainingDurationMs <= 0) {
      const limit = after.durationLimitMs ?? after.activeElapsedMs ?? 0;
      const consumed = after.activeElapsedMs ?? limit;
      throw new RunBudgetError({
        status: "budget_exceeded",
        metric: "duration",
        limit,
        consumed,
        reason: `budget_exceeded: duration ${consumed} reached limit ${limit} during Call LLM`,
      });
    }
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
    });
  }
};
