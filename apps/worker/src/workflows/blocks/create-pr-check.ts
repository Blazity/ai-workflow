import type { WorkflowPrCheckReference } from "@shared/contracts";
import { isRunControlError } from "../run-control-error.js";
import type { PrTriggerPayload } from "../agent-input.js";
import {
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";

async function createPrCheckStep(args: {
  owner: { subjectKey: string; ownerToken: string; runId: string };
  pr: PrTriggerPayload;
  nodeId: string;
  attempt: number;
  activationScope: string;
  name: string;
}) {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const {
    createRunOwnedPrCheck,
    prRunTarget,
  } = await import("../pr-external-resources.js");
  return createRunOwnedPrCheck({
    db: getDb(),
    owner: args.owner,
    target: prRunTarget(args.owner.subjectKey, args.pr),
    nodeId: args.nodeId,
    attempt: args.attempt,
    activationScope: args.activationScope,
    name: args.name,
  });
}
createPrCheckStep.maxRetries = 0;

async function recordCreatePrCheckFailure(message: string): Promise<string> {
  "use step";
  const { randomUUID } = await import("node:crypto");
  const diagnosticId = randomUUID();
  console.error(`[${diagnosticId}] Create PR check failed:`, message);
  return diagnosticId;
}
recordCreatePrCheckFailure.maxRetries = 0;

export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  _resolvedInputs,
  execution,
): Promise<BlockExecutionResult> => {
  if (ctx.entry.kind !== "pr_trigger") {
    return executionError("Create PR check requires a pull request trigger.", {
      category: "binding",
    });
  }
  const name =
    typeof block.params.checkName === "string"
      ? block.params.checkName.trim()
      : "";
  if (!name) {
    return executionError("Create PR check requires a check name.", {
      category: "binding",
    });
  }
  try {
    const check: WorkflowPrCheckReference = await createPrCheckStep({
      owner: {
        subjectKey: ctx.entry.subjectKey,
        ownerToken: ctx.entry.ownerToken,
        runId: ctx.runId,
      },
      pr: ctx.entry.pr,
      nodeId: block.id,
      attempt: execution?.attempt ?? 1,
      activationScope: execution?.activationScopeId ?? "root",
      name,
    });
    return { kind: "next", output: { status: "ok", check } };
  } catch (error) {
    if (isRunControlError(error)) throw error;
    const diagnosticId = await recordCreatePrCheckFailure(
      error instanceof Error ? error.message : String(error),
    );
    return executionError(
      `PR check creation failed. Diagnostic ID: ${diagnosticId}`,
      { category: "provider", phase: "create-pr-check" },
    );
  }
};
