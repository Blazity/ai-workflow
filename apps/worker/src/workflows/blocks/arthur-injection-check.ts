import { z } from "zod";
import { isRunControlError } from "../run-control-error.js";
import { detectBlatantInjection } from "./injection-markers.js";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "./types.js";

export const paramsSchema = z.object({}).strict();

interface InjectionCheckFinding {
  rule: string;
  result: string;
  details?: string;
}

async function blockArthurValidatePromptStep(
  taskId: string,
  content: string,
): Promise<{ ok: boolean; findings: InjectionCheckFinding[] }> {
  "use step";
  const { env } = await import("../../../env.js");
  if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) {
    throw new Error("Arthur is not configured");
  }
  const { ArthurClient } = await import("../../sandbox/arthur-client.js");
  const client = ArthurClient.fromTraceEndpoint(
    env.GENAI_ENGINE_TRACE_ENDPOINT,
    env.GENAI_ENGINE_API_KEY,
  );
  // The per-run task is created without rules, so it must carry a prompt-injection
  // rule before validate_prompt can flag anything. If the rule cannot be added the
  // task stays empty and validate_prompt evaluates nothing; the caller treats an
  // empty result as "flagged" (fail closed), never as clean.
  try {
    await client.addPromptInjectionRule(taskId);
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../../lib/logger.js");
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), taskId },
      "arthur_prompt_injection_rule_add_failed",
    );
  }
  return client.validatePrompt(taskId, content);
}
blockArthurValidatePromptStep.maxRetries = 0;

/**
 * arthur_injection_check: prompt-injection screen. A deterministic local
 * pre-filter always flags blatant override payloads, then Arthur's
 * validate_prompt covers subtler cases. Content is either the resolved `content`
 * input or the ticket description plus comments. Every outcome is a kind "next"
 * output so graphs can branch on it: "ok", "flagged" (with findings), or
 * "skipped" (Arthur unconfigured or no task). The `backend` field names which
 * layer produced the verdict ("local_prefilter", "arthur_engine", or "none").
 *
 * Fail closed: the screen never reports "ok" unless Arthur actually evaluated at
 * least one rule, so a per-run injection rule that never attached (or did not
 * take effect) blocks instead of silently passing (AIW-287). Provider failures
 * are execution errors and carry no bindable output.
 */
export const execute: BlockExecuteFn = async (
  _block,
  _steps,
  ctx,
  resolvedInputs,
): Promise<BlockExecutionResult> => {
  let content: string;
  if (typeof resolvedInputs?.content === "string") {
    content = resolvedInputs.content;
  } else {
    content = [
      ctx.ticket.description,
      ...ctx.ticket.comments.map((comment) => `${comment.author}: ${comment.body}`),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  // Deterministic floor: a blatant, unambiguous injection payload always flags,
  // regardless of Arthur's probabilistic classifier or whether the per-run rule
  // attached in time. Guarantees an identical definitive input yields an
  // identical verdict on every run (AIW-287).
  const prefilterFindings = detectBlatantInjection(content);
  if (prefilterFindings.length > 0) {
    return {
      kind: "next",
      output: {
        status: "flagged",
        backend: "local_prefilter",
        findings: prefilterFindings.map((finding) => ({
          rule: finding.rule,
          result: finding.result,
          details: finding.details,
        })),
      },
    };
  }

  const { env } = await import("../../../env.js");
  if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) {
    return {
      kind: "next",
      output: { status: "skipped", backend: "none", reason: "arthur_not_configured" },
    };
  }
  const { ensureArthurTask } = await import("./prepare-workspace.js");
  const taskId = await ensureArthurTask(ctx);
  if (!taskId) {
    return {
      kind: "next",
      output: { status: "skipped", backend: "none", reason: "arthur_task_missing" },
    };
  }

  try {
    const { ok, findings } = await blockArthurValidatePromptStep(taskId, content);
    // Fail closed: a validate_prompt that evaluated zero rules is not a clean
    // bill of health -- the per-run injection rule never attached or did not take
    // effect, so nothing actually screened the content. Never map that to "ok".
    if (findings.length === 0) {
      return {
        kind: "next",
        output: {
          status: "flagged",
          backend: "arthur_engine",
          reason: "arthur_no_rules_evaluated",
          findings: [],
        },
      };
    }
    return {
      kind: "next",
      output: {
        status: ok ? "ok" : "flagged",
        backend: "arthur_engine",
        findings: findings.map((finding) => ({
          rule: finding.rule,
          result: finding.result,
          ...(finding.details ? { details: finding.details } : {}),
        })),
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
    });
  }
};
