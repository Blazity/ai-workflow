import type { WorkflowPrCheckReference } from "@shared/contracts";
import { isRunControlError } from "../run-control-error.js";
import type { PrTriggerPayload } from "../agent-input.js";
import {
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";

function parseReference(value: unknown): WorkflowPrCheckReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" &&
    typeof candidate.headSha === "string" &&
    typeof candidate.name === "string"
    ? {
        id: candidate.id,
        headSha: candidate.headSha,
        name: candidate.name,
      }
    : null;
}

async function completePrCheckStep(
  args: {
    owner: { subjectKey: string; ownerToken: string; runId: string };
    pr: PrTriggerPayload;
    reference: WorkflowPrCheckReference;
    conclusion: "success" | "failure" | "neutral";
    details: string;
    refreshHead?: boolean;
  },
) {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const {
    completeRunOwnedPrCheck,
    prRunTarget,
  } = await import("../pr-external-resources.js");
  return completeRunOwnedPrCheck({
    db: getDb(),
    owner: args.owner,
    target: prRunTarget(args.owner.subjectKey, args.pr),
    reference: args.reference,
    conclusion: args.conclusion,
    details: args.details,
    refreshHead: args.refreshHead,
  });
}
completePrCheckStep.maxRetries = 0;

async function recordCompletePrCheckFailure(message: string): Promise<string> {
  "use step";
  const { randomUUID } = await import("node:crypto");
  const diagnosticId = randomUUID();
  console.error(`[${diagnosticId}] Complete PR check failed:`, message);
  return diagnosticId;
}
recordCompletePrCheckFailure.maxRetries = 0;

export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
): Promise<BlockExecutionResult> => {
  if (ctx.entry.kind !== "pr_trigger") {
    return executionError("Complete PR check requires a pull request trigger.", {
      category: "binding",
    });
  }
  const reference = parseReference(resolvedInputs.check);
  if (!reference) {
    return executionError("Complete PR check requires a valid check reference.", {
      category: "binding",
    });
  }
  const conclusion = block.params.conclusion;
  if (
    conclusion !== "success" &&
    conclusion !== "failure" &&
    conclusion !== "neutral"
  ) {
    return executionError("Complete PR check has an invalid conclusion.", {
      category: "binding",
    });
  }
  const details =
    typeof resolvedInputs.details === "string"
      ? resolvedInputs.details
      : typeof block.params.details === "string"
        ? block.params.details
        : "";
  const refreshHead = block.params.refreshHead === true;
  try {
    await completePrCheckStep({
      owner: {
        subjectKey: ctx.entry.subjectKey,
        ownerToken: ctx.entry.ownerToken,
        runId: ctx.runId,
      },
      pr: ctx.entry.pr,
      reference,
      conclusion,
      details,
      refreshHead,
    });
    return {
      kind: "next",
      output: { status: "ok", check: reference, conclusion },
    };
  } catch (error) {
    if (isRunControlError(error)) throw error;
    const diagnosticId = await recordCompletePrCheckFailure(
      error instanceof Error ? error.message : String(error),
    );
    return executionError(
      `PR check completion failed. Diagnostic ID: ${diagnosticId}`,
      { category: "provider", phase: "complete-pr-check" },
    );
  }
};
