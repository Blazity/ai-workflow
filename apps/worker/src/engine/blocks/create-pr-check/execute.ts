import type { WorkflowPrCheckReference } from "@shared/contracts";
import type { IntegrationConnectionPin } from "@shared/contracts";
import { isRunControlError } from "../../helpers/run-control-error.js";
import {
  isPullRequestMovedOnResult,
  pullRequestMovedOnError,
} from "../../support/pull-request-moved-on.js";
import type { PrTriggerPayload } from "../../agent-input.js";
import {
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "../support/types.js";

async function createPrCheckStep(args: {
  owner: { subjectKey: string; ownerToken: string; runId: string };
  pr: PrTriggerPayload;
  nodeId: string;
  attempt: number;
  activationScope: string;
  name: string;
  integrationPins?: readonly IntegrationConnectionPin[];
}) {
  "use step";
  const {
    createConnectedRunOwnedPrCheck,
    prRunTarget,
  } = await import("../../runtime/pr-external-resources.js");
  return createConnectedRunOwnedPrCheck({
    owner: args.owner,
    target: prRunTarget(args.owner.subjectKey, args.pr),
    nodeId: args.nodeId,
    attempt: args.attempt,
    activationScope: args.activationScope,
    name: args.name,
    integrationPins: args.integrationPins,
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
  let created: Awaited<ReturnType<typeof createPrCheckStep>>;
  try {
    created = await createPrCheckStep({
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
      integrationPins: ctx.integrationPins,
    });
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
  // The pull request got a newer commit or was closed before its check existed.
  // Nothing broke, so this ends the run as moved on and never as a provider
  // failure (production run wrun_01M3B9X8SHGCE0KQK4YJ0F71VW).
  if (isPullRequestMovedOnResult(created)) {
    return pullRequestMovedOnError(created.movedOn, {
      pr: ctx.entry.pr,
      definitionNodes: ctx.definitionNodes,
      phase: "create-pr-check",
    });
  }
  const check: WorkflowPrCheckReference = created;
  return { kind: "next", output: { status: "ok", check } };
};
