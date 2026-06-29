import type {
  PostPrGateConfig,
  PostPrGateConfigStep,
  PostPrGateStepContext,
  PostPrGateStepRegistry,
  PostPrGateStepResult,
} from "./types.js";
import { postPrGateTicketInputFields } from "./types.js";
import type {
  CheckRunConclusion,
  GateStatusCapableVCS,
  GateStatusRef,
} from "../adapters/vcs/types.js";
import { hasGateStatusCapability } from "../adapters/vcs/types.js";

interface RunnerLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface RunPostPrGateInput {
  context: PostPrGateStepContext;
  config: PostPrGateConfig;
  /** Pre-created gate status refs, in the same order as config.postPrGate.steps. */
  gateStatusRefs: GateStatusRef[];
  registry: PostPrGateStepRegistry;
  logger?: RunnerLogger;
}

export interface PostPrGateRunSummary {
  ranSteps: number;
  failed: boolean;
}

/**
 * Sequentially run gate steps. Each step's gate status ref is provided by the
 * caller (the workflow eagerly creates them all up front so they appear on
 * the PR immediately).
 *
 * Failure handling:
 *   - step throws or times out → conclusion = failure, details = error message
 *   - onFailure: "fail" + failure conclusion → mark remaining check runs as
 *     "cancelled" and stop the loop
 *   - onFailure: "continue" → log and proceed
 */
export async function executePostPrGatePhase(
  input: RunPostPrGateInput,
): Promise<PostPrGateRunSummary> {
  const { context, config, gateStatusRefs, registry, logger } = input;
  if (!hasGateStatusCapability(context.adapters.vcs)) {
    throw new Error("VCS adapter does not support gate statuses");
  }
  const vcs = context.adapters.vcs as typeof context.adapters.vcs & GateStatusCapableVCS;

  const steps = config.postPrGate.steps;
  if (steps.length !== gateStatusRefs.length) {
    throw new Error(
      `gateStatusRefs length (${gateStatusRefs.length}) must equal steps length (${steps.length})`,
    );
  }

  let failed = false;
  let ranSteps = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const gateStatusRef = gateStatusRefs[i];
    const displayName = step.name ?? step.uses;

    if (failed) {
      // Previous step had onFailure: "fail" — cancel remaining.
      await vcs.updateGateStatus(gateStatusRef, {
        status: "completed",
        conclusion: "cancelled",
        summary: "Skipped — previous required gate step failed.",
      });
      continue;
    }

    ranSteps++;

    let result: PostPrGateStepResult;
    try {
      const handler = registry[step.uses];
      if (!handler) {
        throw new Error(`Step "${step.uses}" is not registered`);
      }
      result = await withTimeout(
        handler({
          context: {
            ...context,
            ticket: selectTicketFields(context.ticket, step),
          },
          config: step.with,
          step,
        }),
        step.timeoutMs,
        displayName,
      );
    } catch (err) {
      const message = errorMessage(err);
      logger?.warn({ step: displayName, err: message }, "post_pr_gate_step_error");
      result = {
        conclusion: "failure",
        summary: `Gate step "${displayName}" errored.`,
        details: message,
      };
    }

    await vcs.updateGateStatus(gateStatusRef, {
      status: "completed",
      conclusion: result.conclusion as CheckRunConclusion,
      summary: result.summary,
      details: result.details,
      annotations: result.annotations,
    });

    if (result.conclusion === "failure" && step.onFailure === "fail") {
      failed = true;
    }
  }

  return { ranSteps, failed };
}

function selectTicketFields(
  ticket: PostPrGateStepContext["ticket"],
  step: PostPrGateConfigStep,
): PostPrGateStepContext["ticket"] {
  if (ticket === null) return null;
  const selected = selectedTicketFields(step.with);
  const result: NonNullable<PostPrGateStepContext["ticket"]> = {};
  for (const field of selected) {
    if (ticket[field] !== undefined) {
      (result as Record<string, unknown>)[field] = ticket[field];
    }
  }
  return result;
}

function selectedTicketFields(
  config: unknown,
): Array<(typeof postPrGateTicketInputFields)[number]> {
  if (!isRecord(config)) return [...postPrGateTicketInputFields];
  const input = config.input;
  if (!isRecord(input)) return [...postPrGateTicketInputFields];
  const fields = input.ticket;
  if (!Array.isArray(fields)) return [...postPrGateTicketInputFields];
  return postPrGateTicketInputFields.filter((f) => fields.includes(f));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  stepName: string,
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Step "${stepName}" timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
