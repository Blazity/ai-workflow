import { z } from "zod";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    contentFromStep: z.string().trim().min(1).optional(),
  })
  .strict();

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
  return client.validatePrompt(taskId, content);
}
blockArthurValidatePromptStep.maxRetries = 0;

/**
 * arthur_injection_check: report-only prompt-injection screen via Arthur's
 * validate_prompt. Content is either the referenced block's output (JSON
 * stringified) or the ticket description plus comments. Every outcome is a
 * kind "next" output so graphs can branch on it: "ok", "flagged" (with
 * findings), or "skipped" (Arthur unconfigured, no task, or a client error).
 */
export const execute: BlockExecuteFn = async (block, steps, ctx): Promise<BlockExecutionResult> => {
  const { env } = await import("../../../env.js");
  if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) {
    return { kind: "next", output: { status: "skipped", reason: "arthur_not_configured" } };
  }
  if (!ctx.arthur.taskId) {
    return { kind: "next", output: { status: "skipped", reason: "arthur_task_missing" } };
  }

  const contentFromStep =
    typeof block.params.contentFromStep === "string" ? block.params.contentFromStep.trim() : "";
  let content: string;
  if (contentFromStep.length > 0) {
    const source = steps[contentFromStep];
    if (!source) {
      return {
        kind: "next",
        output: { status: "skipped", reason: `no output from block "${contentFromStep}"` },
      };
    }
    content = JSON.stringify(source.output);
  } else {
    content = [
      ctx.ticket.description,
      ...ctx.ticket.comments.map((comment) => `${comment.author}: ${comment.body}`),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  try {
    const { ok, findings } = await blockArthurValidatePromptStep(ctx.arthur.taskId, content);
    return {
      kind: "next",
      output: {
        status: ok ? "ok" : "flagged",
        findings: findings.map((finding) => ({
          rule: finding.rule,
          result: finding.result,
          ...(finding.details ? { details: finding.details } : {}),
        })),
      },
    };
  } catch (err) {
    return {
      kind: "next",
      output: {
        status: "skipped",
        reason: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      },
    };
  }
};
