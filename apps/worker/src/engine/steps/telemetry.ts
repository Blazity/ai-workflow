/* eslint-disable max-lines, max-lines-per-function */
import { type UsageTotals } from "../../sandbox/usage.js";
import { configuredReplaySecrets } from "../../run-observability/configured-secrets.js";
import { type ClarificationDecisionObservation } from "../../run-observability/agent-observations.js";
import type { ClarificationDecisionDigest } from "../helpers/clarification-decision-digest.js";
import { replayCaptureWithinTimeout } from "../../run-observability/capture-timeout.js";
import { usageSnapshot } from "../../engine/support/run-analysis-report.js";
import { summarizeRunBlockStatuses } from "../run-block-status-summary.js";
import { type RunBudgetFailure } from "../helpers/run-budget.js";
import { redactDiagnosticText } from "../../sandbox/agents/redact.js";
import { errorMessage } from "../helpers/repository-failure.js";
import type { BlockRunState, ReplayAttemptOutcome, ReplayObservationKind, ReplaySanitizedEnvelope, ResolvedPromptReference, RunPullRequest, RunRepositoryAccess, WorkflowReplayGraphSnapshot, WorkflowReplaySelectedTransition, HarnessRunManifestRecord } from "@shared/contracts";
import type {
  PreparedReplayAttemptPersistence,
  ReplayAttemptPersistenceState,
} from "../../run-observability/runtime-hooks.js";

async function persistPreparedReplayAttempt(input: {
  read: () => Promise<ReplayAttemptPersistenceState | null>;
  replace: (prepared: PreparedReplayAttemptPersistence) => Promise<boolean>;
  prepare: (
    current: ReplayAttemptPersistenceState,
  ) => PreparedReplayAttemptPersistence;
  errorMessage: string;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const current = await input.read();
    if (!current) return false;
    if (await input.replace(input.prepare(current))) return true;
  }
  throw new Error(input.errorMessage);
}

/**
 * Persist the run's cost/usage (+ agent PR + ticket) to the durable telemetry
 * table. Called from the workflow's outer finally so cost is recorded on every
 * exit - success, clarification, or failure. The repository write is an
 * idempotent upsert, so the durable step retries transient failures before the
 * caller gives up without changing the run's already-decided outcome. Every
 * failed attempt is logged here with the run id and ticket key, so a silent
 * break (e.g. a schema drift like a missing column on the run's Neon branch)
 * surfaces immediately instead of dropping run history for days unnoticed.
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
  // The whole body is guarded, not just the upsert: the dynamic imports and the
  // world capture below can reject too, and a failure that produced no log was
  // how run history could go missing for days unnoticed. Every attempt logs and
  // rethrows, so the durable retry still happens and the caller still sees the
  // exhausted budget.
  try {
    const { loadRunTelemetryPort } = await import("../internal/ports.js");
    const { recordConnectedRunUsage } = await loadRunTelemetryPort();
    const { finalizeConnectedRunAnalysisUsage } = await import("../../run-analysis/persistence.js");
    const { getWorld } = await import("workflow/runtime");
    const collectRunDetailMod = await import(
      "../support/collect-run-detail.js"
    );
    const capturedSteps = await collectRunDetailMod.captureRunStepsBestEffort(
      getWorld() as unknown as import("../support/collect-run-detail.js").RunDetailSource,
      payload.runId,
    );
    const steps = collectRunDetailMod.sanitizeRunStepsForDiagnosticError(
      capturedSteps,
      payload.executionError,
    );
    const { totals } = payload;
    await recordConnectedRunUsage({
      runId: payload.runId,
      // This is the agent workflow - its canonical identity (mirrors
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
    // Deliberately inside the guarded body but swallowed on its own: the
    // analysis snapshot is a nice-to-have, so it must not fail an otherwise
    // persisted telemetry write.
    try {
      await finalizeConnectedRunAnalysisUsage(
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
  } catch (error) {
    const { logger } = await import("../../infra/logger.js");
    logger.error(
      {
        runId: payload.runId,
        ticketKey: payload.ticketKey,
        error: redactDiagnosticText(errorMessage(error)),
      },
      "run_completion_telemetry_persist_failed",
    );
    throw error;
  }
}
recordRunTelemetryStep.maxRetries = 3;

/**
 * Last-resort guard around the durable step, called from the workflow body.
 * console.error and not the pino logger on purpose: this function runs in the
 * workflow bundle, which rejects any module reaching a Node builtin
 * (workflow-import-boundary.test.ts fails the build on `import
 * "../../infra/logger.js"` here with "You are attempting to use pino"), so the
 * structured log lives inside the step and this keeps the base's console line.
 */
async function persistRunTelemetryBestEffort(
  payload: Parameters<typeof recordRunTelemetryStep>[0],
): Promise<void> {
  await recordRunTelemetryStep(payload).catch((error: unknown) => {
    console.error(
      "run_completion_telemetry_persist_exhausted",
      payload.runId,
      payload.ticketKey,
      redactDiagnosticText(errorMessage(error)),
    );
  });
}

async function closeTerminalPrChecksStep(payload: {
  runId: string;
  intent: "timed_out" | "cancelled";
  details: string;
}): Promise<{ closed: number; pending: number }> {
  "use step";
  const { closeConnectedRunPrChecks } = await import("../runtime/pr-external-resources.js");
  return closeConnectedRunPrChecks(payload);
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
  /** The repositories this run may touch, frozen by the run-start step. An
   *  OPTIONAL parameter, so a run suspended before this field existed replays
   *  this step's stored result unchanged. */
  repositoryAccess?: RunRepositoryAccess;
}) {
  "use step";
  const { loadRunTelemetryPort } = await import("../internal/ports.js");
  const { recordConnectedBlockStatuses } = await loadRunTelemetryPort();
  await recordConnectedBlockStatuses({
    ...payload,
    blockStatuses: summarizeRunBlockStatuses(payload.blockStatuses),
  });
}
recordBlockStatusesStep.maxRetries = 0;

async function markV2ReplayCaptureUnavailable(payload: {
  runId: string;
  organizationId: string;
}): Promise<void> {
  try {
    const { markConnectedRunReplayCaptureUnavailable } = await import(
      "../../db/repositories/runs/run-observability.js"
    );
    await replayCaptureWithinTimeout(
      markConnectedRunReplayCaptureUnavailable(payload),
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
        const { createConnectedAuthRepository } = await import(
          "../../db/repositories/auth.js"
        );
        const { getConnectedWorkflowDefinitionRawState } = await import(
          "../../db/repositories/definitions/connected.js"
        );
        const { captureConnectedRunObservationStart } = await import(
          "../../db/repositories/runs/run-observability.js"
        );
        const { sanitizeV2ReplaySnapshotForCapture } = await import(
          "../../run-observability/runtime-hooks.js"
        );
        const organization = await createConnectedAuthRepository().findOrganizationBySlug(
          env.DASHBOARD_ORG_SLUG,
        );
        if (!organization) {
          throw new Error(`Dashboard organization "${env.DASHBOARD_ORG_SLUG}" is unavailable.`);
        }
        organizationId = organization.id;
        if (captureAbandoned) {
          throw new Error("Replay capture was abandoned");
        }
        const definition = await getConnectedWorkflowDefinitionRawState(payload.definitionId!);
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
        const snapshot = sanitizeV2ReplaySnapshotForCapture({
          graph,
          layout,
          secrets: configuredReplaySecrets(),
        });
        if (!snapshot) {
          throw new Error("Replay snapshot exceeds safe capture limits");
        }
        return captureConnectedRunObservationStart({
          runId: payload.runId,
          organizationId: organizationId!,
          definitionId: payload.definitionId!,
          definitionVersion: payload.definitionVersion!,
          definitionSchemaVersion: 2,
          graph: snapshot.graph,
          layout: snapshot.layout,
          runtimeManifest: payload.runtimeManifest,
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
    const { startConnectedWorkflowBlockAttempt } = await import(
      "../../db/repositories/runs/run-observability.js"
    );
    const result = await replayCaptureWithinTimeout(
      startConnectedWorkflowBlockAttempt({
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
    const {
      getConnectedWorkflowBlockAttemptPersistence,
      replaceConnectedWorkflowBlockAttemptPersistence,
    } = await import(
      "../../db/repositories/runs/run-observability.js"
    );
    const { prepareReplayAttemptObservationPersistence } = await import(
      "../../run-observability/runtime-hooks.js"
    );
    for (const observation of payload.observations) {
      const recorded = await replayCaptureWithinTimeout(
        persistPreparedReplayAttempt({
          read: () => getConnectedWorkflowBlockAttemptPersistence({
            runId: payload.runId,
            organizationId: payload.organizationId,
            attemptId: payload.attemptId,
          }),
          replace: (prepared) => replaceConnectedWorkflowBlockAttemptPersistence({
            runId: payload.runId,
            organizationId: payload.organizationId,
            attemptId: payload.attemptId,
            ...prepared,
          }),
          prepare: (current) => prepareReplayAttemptObservationPersistence(
            current,
            observation,
          ),
          errorMessage: "Concurrent attempt observations exceeded the retry limit",
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
    const {
      getConnectedWorkflowBlockAttemptPersistence,
      replaceConnectedWorkflowBlockAttemptPersistence,
    } = await import(
      "../../db/repositories/runs/run-observability.js"
    );
    const { prepareReplayAttemptWaitingPersistence } = await import(
      "../../run-observability/runtime-hooks.js"
    );
    const updated = await replayCaptureWithinTimeout(
      persistPreparedReplayAttempt({
        read: () => getConnectedWorkflowBlockAttemptPersistence({
          runId: payload.runId,
          organizationId: payload.organizationId,
          attemptId: payload.attemptId,
        }),
        replace: (prepared) => replaceConnectedWorkflowBlockAttemptPersistence({
          runId: payload.runId,
          organizationId: payload.organizationId,
          attemptId: payload.attemptId,
          ...prepared,
        }),
        prepare: (current) => prepareReplayAttemptWaitingPersistence(current, {
          selectedTransition: payload.selectedTransition,
          observations: payload.observations,
        }),
        errorMessage: "Concurrent attempt state updates exceeded the retry limit",
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
    const {
      getConnectedWorkflowBlockAttemptPersistence,
      replaceConnectedWorkflowBlockAttemptPersistence,
    } = await import(
      "../../db/repositories/runs/run-observability.js"
    );
    const { prepareReplayAttemptFinishPersistence } = await import(
      "../../run-observability/runtime-hooks.js"
    );
    const finished = await replayCaptureWithinTimeout(
      persistPreparedReplayAttempt({
        read: () => getConnectedWorkflowBlockAttemptPersistence({
          runId: payload.runId,
          organizationId: payload.organizationId,
          attemptId: payload.attemptId,
        }),
        replace: (prepared) => replaceConnectedWorkflowBlockAttemptPersistence({
          runId: payload.runId,
          organizationId: payload.organizationId,
          attemptId: payload.attemptId,
          ...prepared,
        }),
        prepare: (current) => prepareReplayAttemptFinishPersistence(current, {
          state: payload.state,
          outcome: payload.outcome,
          selectedTransition: payload.selectedTransition,
          diagnosticId: payload.diagnosticId,
          observations: payload.observations,
          completedAt: new Date(payload.completedAt),
        }),
        errorMessage: "Concurrent attempt finalization exceeded the retry limit",
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
