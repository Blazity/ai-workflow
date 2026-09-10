/* eslint-disable max-lines, max-lines-per-function */
import { type UsageTotals } from "../../sandbox/usage.js";
import { configuredReplaySecrets } from "../../run-observability/configured-secrets.js";
import { type ClarificationDecisionObservation } from "../../run-observability/agent-observations.js";
import type { ClarificationDecisionDigest } from "../helpers/clarification-decision-digest.js";
import { replayCaptureWithinTimeout } from "../../run-observability/capture-timeout.js";
import { usageSnapshot } from "../../run-analysis/report.js";
import { type RunBudgetFailure } from "../helpers/run-budget.js";
import { redactDiagnosticText } from "../../sandbox/agents/redact.js";
import { errorMessage } from "../helpers/repository-failure.js";
import type { BlockRunState, ReplayAttemptOutcome, ReplayObservationKind, ReplaySanitizedEnvelope, ResolvedPromptReference, RunPullRequest, WorkflowReplayGraphSnapshot, WorkflowReplaySelectedTransition, HarnessRunManifestRecord } from "@shared/contracts";

/**
 * Persist the run's cost/usage (+ agent PR + ticket) to the durable telemetry
 * table. Called from the workflow's outer finally so cost is recorded on every
 * exit — success, clarification, or failure. maxRetries = 0 and the caller
 * swallows errors: telemetry must never retry or fail the run.
 */
export async function recordRunTelemetryStep(payload: {
  runId: string;
  subjectKey: string;
  status: "success" | "failed" | "awaiting";
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  model: string | null;
  totals: UsageTotals;
  budgetFailure: RunBudgetFailure | null;
  pr: { url: string; number: number } | null;
  prs: RunPullRequest[] | null;
  executionError: { message: string; code: string } | null;
  harnessManifests?: HarnessRunManifestRecord[];
}) {
  "use step";
  const { loadRunTelemetryPort } = await import("../internal/ports.js");
  const { getDb } = await import("../../db/client.js");
  const { recordRunUsage } = await loadRunTelemetryPort();
  const { finalizeRunAnalysisUsage } = await import("../../run-analysis/store.js");
  const { getWorld } = await import("workflow/runtime");
  const collectRunDetailMod = await import(
    "../../services/overview/collect-run-detail.js"
  );
  const capturedSteps = await collectRunDetailMod.captureRunStepsBestEffort(
    getWorld() as unknown as import("../../services/overview/collect-run-detail.js").RunDetailSource,
    payload.runId,
  );
  const steps = collectRunDetailMod.sanitizeRunStepsForDiagnosticError(
    capturedSteps,
    payload.executionError,
  );
  const { totals } = payload;
  await recordRunUsage(getDb(), {
    runId: payload.runId,
    // This is the agent workflow — its canonical identity (mirrors
    // WORKFLOW_MAP.agentWorkflow in lib/overview/collect-runs.ts). Recorded here
    // so the run is attributed even when no cron snapshot ever observes it.
    workflowId: "wf_agent",
    workflowName: "Agent",
    subjectKey: payload.subjectKey,
    status: payload.status,
    // Durable "why" for a failed run: the user-facing execution error when one
    // was captured, else a short derivation from the structured budget stop.
    statusReason:
      payload.status === "failed"
        ? payload.executionError?.message ??
          (payload.budgetFailure
            ? `Run stopped on budget: ${payload.budgetFailure.reason}`
            : null)
        : null,
    ticketKey: payload.ticketKey,
    ticketTitle: payload.ticketTitle,
    ticketUrl: payload.ticketUrl,
    model: payload.model,
    costUsd: totals.costUsd,
    costKnown: totals.costKnown,
    tokensInput: totals.tokensInput,
    tokensCached: totals.tokensCached,
    tokensOutput: totals.tokensOutput,
    phases: totals.phases,
    steps,
    budgetFailure: payload.budgetFailure,
    prUrl: payload.pr?.url ?? null,
    prNumber: payload.pr?.number ?? null,
    prs: payload.prs,
    harnessManifests: payload.harnessManifests,
  });
  try {
    await finalizeRunAnalysisUsage(
      getDb(),
      payload.runId,
      usageSnapshot(payload.totals, new Date().toISOString()),
    );
  } catch (error) {
    console.error(
      "run_analysis_final_usage_failed",
      payload.runId,
      redactDiagnosticText(errorMessage(error)),
    );
  }
}
recordRunTelemetryStep.maxRetries = 0;

async function persistRunTelemetryBestEffort(
  payload: Parameters<typeof recordRunTelemetryStep>[0],
  ticketIdentifier: string,
): Promise<void> {
  await recordRunTelemetryStep(payload).catch(() => {
    console.error(
      `Run telemetry failed to persist for ${ticketIdentifier} (run ${payload.runId})`,
    );
  });
}

async function closeTerminalPrChecksStep(payload: {
  runId: string;
  intent: "timed_out" | "cancelled";
  details: string;
}): Promise<{ closed: number; pending: number }> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { closeRunPrChecks } = await import("../runtime/pr-external-resources.js");
  return closeRunPrChecks({ db: getDb(), ...payload });
}
closeTerminalPrChecksStep.maxRetries = 0;

async function recordBlockStatusesStep(payload: {
  runId: string;
  subjectKey: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  definitionVersion: number | null;
  definitionId: number | null;
  blockStatuses: Record<string, BlockRunState>;
  promptManifest?: ResolvedPromptReference[];
  harnessManifests?: HarnessRunManifestRecord[];
}) {
  "use step";
  const { loadRunTelemetryPort } = await import("../internal/ports.js");
  const { getDb } = await import("../../db/client.js");
  const { recordBlockStatuses } = await loadRunTelemetryPort();
  await recordBlockStatuses(getDb(), payload);
}
recordBlockStatusesStep.maxRetries = 0;

async function markV2ReplayCaptureUnavailable(payload: {
  runId: string;
  organizationId: string;
}): Promise<void> {
  try {
    const { getDb } = await import("../../db/client.js");
    const { markRunReplayCaptureUnavailable } = await import(
      "../../run-observability/store.js"
    );
    await replayCaptureWithinTimeout(
      markRunReplayCaptureUnavailable({
        db: getDb(),
        ...payload,
      }),
    );
  } catch {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { runId: payload.runId },
      "run_replay_capture_unavailable_marker_failed",
    );
  }
}

async function markV2RunObservationUnavailableStep(payload: {
  runId: string;
  organizationId: string;
}): Promise<void> {
  "use step";
  await markV2ReplayCaptureUnavailable(payload);
}
markV2RunObservationUnavailableStep.maxRetries = 0;

async function digestClarificationDecisionInputsStep(payload: {
  ticketValue: unknown;
  contextValue: unknown;
}): Promise<ClarificationDecisionDigest> {
  "use step";
  const { digestClarificationDecisionInputs } = await import(
    "../helpers/clarification-decision-digest.js"
  );
  return digestClarificationDecisionInputs(payload.ticketValue, payload.contextValue);
}
digestClarificationDecisionInputsStep.maxRetries = 0;

/**
 * AIW-267: builds the decision-inputs observation for a research/impl phase
 * that reached a structured decision, so a future "why did it ask (or not)"
 * question is answerable from the run ID alone. Best-effort like the rest of
 * replay capture: a failed digest just means the observation is skipped, it
 * never fails the phase.
 */
async function resolveClarificationDecisionObservation(input: {
  status: string;
  questions?: string[] | null;
  suggestedAnswers?: string[] | null;
  ticketValue: unknown;
  contextValue: unknown;
  harnessProfileHash: string | null;
}): Promise<ClarificationDecisionObservation | undefined> {
  try {
    const digest = await digestClarificationDecisionInputsStep({
      ticketValue: input.ticketValue,
      contextValue: input.contextValue,
    });
    return {
      status: input.status,
      questions: input.questions ?? null,
      suggestedAnswers: input.suggestedAnswers ?? null,
      ...digest,
      harnessProfileHash: input.harnessProfileHash,
    };
  } catch {
    return undefined;
  }
}

async function captureV2RunObservationStartStep(payload: {
  runId: string;
  definitionId: number | null;
  definitionVersion: number | null;
  graph: WorkflowReplayGraphSnapshot;
  runtimeManifest: ReplaySanitizedEnvelope;
}): Promise<{ organizationId: string } | null> {
  "use step";
  const { loadEnvironmentPort } = await import("../internal/ports.js");
  if (
    payload.definitionId === null ||
    payload.definitionVersion === null
  ) {
    return null;
  }
  let organizationId: string | null = null;
  let captureAbandoned = false;
  try {
    const capture = await replayCaptureWithinTimeout(
      (async () => {
        const { env } = await loadEnvironmentPort();
        const { getDb } = await import("../../db/client.js");
        const { dashboardOrganizationId } = await import(
          "../../workflow-definition/harness-profile-runtime.js"
        );
        const { getWorkflowDefinitionRawState } = await import(
          "../../workflow-definition/store.js"
        );
        const { captureRunObservationStart } = await import(
          "../../run-observability/store.js"
        );
        const db = getDb();
        organizationId = await dashboardOrganizationId(
          db,
          env.DASHBOARD_ORG_SLUG,
        );
        if (captureAbandoned) {
          throw new Error("Replay capture was abandoned");
        }
        const definition = await getWorkflowDefinitionRawState(
          db,
          payload.definitionId!,
        );
        if (captureAbandoned) {
          throw new Error("Replay capture was abandoned");
        }
        const layout = definition?.layout ?? {
          nodes: Object.fromEntries(
            payload.graph.nodes.map((node) => [
              node.id,
              { x: node.x, y: node.y },
            ]),
          ),
          edges: {},
        };
        const graph = {
          ...payload.graph,
          nodes: payload.graph.nodes.map((node) => ({
            ...node,
            ...(layout.nodes[node.id] ?? { x: node.x, y: node.y }),
          })),
        };
        return captureRunObservationStart({
          db,
          runId: payload.runId,
          organizationId: organizationId!,
          definitionId: payload.definitionId!,
          definitionVersion: payload.definitionVersion!,
          definitionSchemaVersion: 2,
          graph,
          layout,
          runtimeManifest: payload.runtimeManifest,
          secrets: configuredReplaySecrets(),
        });
      })(),
    );
    if (!organizationId) {
      throw new Error("Replay capture organization could not be resolved");
    }
    if (capture.captureStatus !== "available") {
      await markV2ReplayCaptureUnavailable({
        runId: payload.runId,
        organizationId,
      });
      return null;
    }
    return organizationId ? { organizationId } : null;
  } catch {
    captureAbandoned = true;
    if (organizationId) {
      await markV2ReplayCaptureUnavailable({
        runId: payload.runId,
        organizationId,
      });
    }
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { runId: payload.runId },
      "run_replay_capture_start_failed",
    );
    return null;
  }
}
captureV2RunObservationStartStep.maxRetries = 0;

async function startV2RunObservationAttemptStep(payload: {
  runId: string;
  organizationId: string;
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  startedAt: string;
}): Promise<number | null> {
  "use step";
  try {
    const { getDb } = await import("../../db/client.js");
    const { startWorkflowBlockAttempt } = await import(
      "../../run-observability/store.js"
    );
    const result = await replayCaptureWithinTimeout(
      startWorkflowBlockAttempt({
        db: getDb(),
        runId: payload.runId,
        organizationId: payload.organizationId,
        nodeId: payload.nodeId,
        attempt: payload.attempt,
        activationScopeId: payload.activationScopeId,
        startedAt: new Date(payload.startedAt),
      }),
    );
    return result.attemptId;
  } catch {
    await markV2ReplayCaptureUnavailable(payload);
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      {
        runId: payload.runId,
        nodeId: payload.nodeId,
        attempt: payload.attempt,
      },
      "run_replay_attempt_start_failed",
    );
    return null;
  }
}
startV2RunObservationAttemptStep.maxRetries = 0;

interface SanitizedReplayObservation {
  kind: ReplayObservationKind;
  envelope: ReplaySanitizedEnvelope;
}

/**
 * Append observations to a still-running attempt.
 *
 * The other two writers are state transitions and carry their observations as
 * cargo. A block that polls for the better part of an hour has no transition to
 * hang them on, and waiting for its finish is what made a long checks phase
 * indistinguishable from a hung run. This appends and changes no state.
 *
 * maxRetries 0 like every capture step: it is best effort, and a failure here
 * returns false so the caller can trip the capture breaker rather than the run.
 */
async function flushV2RunObservationsStep(payload: {
  runId: string;
  organizationId: string;
  attemptId: number;
  observations: SanitizedReplayObservation[];
}): Promise<boolean> {
  "use step";
  try {
    const { getDb } = await import("../../db/client.js");
    const { recordWorkflowBlockAttemptObservation } = await import(
      "../../run-observability/store.js"
    );
    const db = getDb();
    for (const observation of payload.observations) {
      const recorded = await replayCaptureWithinTimeout(
        recordWorkflowBlockAttemptObservation({
          db,
          runId: payload.runId,
          organizationId: payload.organizationId,
          attemptId: payload.attemptId,
          kind: observation.kind,
          envelope: observation.envelope,
        }),
      );
      if (!recorded) {
        throw new Error("Replay attempt is no longer available");
      }
    }
    return true;
  } catch {
    await markV2ReplayCaptureUnavailable(payload);
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { runId: payload.runId, attemptId: payload.attemptId },
      "run_replay_attempt_flush_failed",
    );
    return false;
  }
}
flushV2RunObservationsStep.maxRetries = 0;

async function updateV2RunObservationWaitingStep(payload: {
  runId: string;
  organizationId: string;
  attemptId: number;
  selectedTransition: WorkflowReplaySelectedTransition;
  observations: SanitizedReplayObservation[];
}): Promise<boolean> {
  "use step";
  try {
    const { getDb } = await import("../../db/client.js");
    const { updateWorkflowBlockAttemptState } = await import(
      "../../run-observability/store.js"
    );
    const updated = await replayCaptureWithinTimeout(
      updateWorkflowBlockAttemptState({
        db: getDb(),
        runId: payload.runId,
        organizationId: payload.organizationId,
        attemptId: payload.attemptId,
        selectedTransition: payload.selectedTransition,
        state: "waiting_loop",
        observations: payload.observations,
      }),
    );
    if (!updated) {
      throw new Error("Replay attempt is no longer available");
    }
    return true;
  } catch {
    await markV2ReplayCaptureUnavailable(payload);
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { runId: payload.runId, attemptId: payload.attemptId },
      "run_replay_attempt_waiting_failed",
    );
    return false;
  }
}
updateV2RunObservationWaitingStep.maxRetries = 0;

async function finishV2RunObservationAttemptStep(payload: {
  runId: string;
  organizationId: string;
  attemptId: number;
  state:
    | "waiting_for_clarification"
    | "completed"
    | "failed"
    | "cancelled"
    | "skipped";
  outcome: ReplayAttemptOutcome;
  selectedTransition: WorkflowReplaySelectedTransition | null;
  diagnosticId: string | null;
  observations: SanitizedReplayObservation[];
  completedAt: string;
}): Promise<boolean> {
  "use step";
  try {
    const { getDb } = await import("../../db/client.js");
    const { finishWorkflowBlockAttempt } = await import(
      "../../run-observability/store.js"
    );
    const finished = await replayCaptureWithinTimeout(
      finishWorkflowBlockAttempt({
        db: getDb(),
        runId: payload.runId,
        organizationId: payload.organizationId,
        attemptId: payload.attemptId,
        state: payload.state,
        outcome: payload.outcome,
        selectedTransition: payload.selectedTransition,
        diagnosticId: payload.diagnosticId,
        observations: payload.observations,
        completedAt: new Date(payload.completedAt),
      }),
    );
    if (!finished) {
      throw new Error("Replay attempt is no longer available");
    }
    return true;
  } catch {
    await markV2ReplayCaptureUnavailable(payload);
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { runId: payload.runId, attemptId: payload.attemptId },
      "run_replay_attempt_finish_failed",
    );
    return false;
  }
}
finishV2RunObservationAttemptStep.maxRetries = 0;
export { SanitizedReplayObservation, captureV2RunObservationStartStep, closeTerminalPrChecksStep, finishV2RunObservationAttemptStep, flushV2RunObservationsStep, markV2RunObservationUnavailableStep, persistRunTelemetryBestEffort, recordBlockStatusesStep, resolveClarificationDecisionObservation, startV2RunObservationAttemptStep, updateV2RunObservationWaitingStep };
