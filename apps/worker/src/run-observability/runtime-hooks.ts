import type {
  BlockOutput,
  ReplayAttemptOutcome,
  ReplayAttemptState,
  ReplayObservationKind,
  ReplaySanitizedEnvelope,
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowReplayGraphSnapshot,
  WorkflowReplayLayoutSnapshot,
  WorkflowReplaySelectedTransition,
} from "@shared/contracts";
import type { V2InvocationObservation } from "../workflow-definition/invocation-context.js";
import type {
  V2InvocationIdentity,
  V2InvocationTerminalState,
  V2SchedulerHooks,
} from "../workflow-definition/v2-scheduler.js";
import { MAX_REPLAY_ATTEMPTS_PER_RUN } from "./limits.js";
import {
  appendReplayLogEnvelope,
  enforceReplayAttemptStorageBudget,
  REPLAY_ATTEMPT_MAX_BYTES,
  sanitizeReplayAttemptOutcome,
  sanitizeReplayGraphSnapshot,
  sanitizeReplayLayoutSnapshot,
  type ReplayAttemptEnvelopeSet,
} from "./sanitizer.js";

const ATTEMPT_ROW_BUDGET_OVERHEAD = 1024;
const MAX_SELECTED_EDGE_IDS = 400;
const MAX_TRANSITION_IDENTIFIER_CHARACTERS = 200;

export const REPLAY_ATTEMPT_CAS_ATTEMPTS = 64;

export interface ReplayAttemptPersistenceState {
  state: ReplayAttemptState;
  outcome: ReplayAttemptOutcome | null;
  selectedTransition: WorkflowReplaySelectedTransition | null;
  diagnosticId: string | null;
  inputEnvelope: ReplaySanitizedEnvelope | null;
  outputEnvelope: ReplaySanitizedEnvelope | null;
  logEnvelope: ReplaySanitizedEnvelope | null;
  metadataEnvelope: ReplaySanitizedEnvelope | null;
  observationRevision: number;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
}

export interface ReplayAttemptObservation {
  kind: ReplayObservationKind;
  envelope: ReplaySanitizedEnvelope;
}

export interface PreparedReplayAttemptPersistence {
  expectedRevision: number;
  state: ReplayAttemptState;
  outcome: ReplayAttemptOutcome | null;
  selectedTransition: WorkflowReplaySelectedTransition | null;
  diagnosticId: string | null;
  inputEnvelope: ReplaySanitizedEnvelope | null;
  outputEnvelope: ReplaySanitizedEnvelope | null;
  logEnvelope: ReplaySanitizedEnvelope | null;
  metadataEnvelope: ReplaySanitizedEnvelope | null;
  completedAt: Date | null;
  durationMs: number | null;
  updatedAt: Date;
}

export interface RunObservationAttemptFinish {
  state: Exclude<ReplayAttemptState, "running" | "waiting_loop">;
  outcome: ReplayAttemptOutcome;
  selectedTransition: WorkflowReplaySelectedTransition | null;
  diagnosticId: string | null;
}

export interface V2RunObservationSink {
  start(
    identity: V2InvocationIdentity,
    startedAt: Date,
  ): Promise<number | null>;
  observe(
    attemptId: number,
    observation: V2InvocationObservation,
  ): Promise<void>;
  /**
   * Write whatever `observe` has buffered for this attempt, without ending it.
   *
   * Optional: a sink that persists on every observe has nothing to do here.
   * The one that does not (the workflow sink batches observations onto the
   * attempt's next state write) needs this so a long-polling block is readable
   * while it is still running.
   */
  flush?(attemptId: number): Promise<void>;
  updateWaiting(
    attemptId: number,
    selectedTransition: WorkflowReplaySelectedTransition,
  ): Promise<void>;
  finish(
    attemptId: number,
    finish: RunObservationAttemptFinish,
    completedAt: Date,
  ): Promise<void>;
  markUnavailable(): Promise<void>;
}

export type V2RunObservationHooks = Pick<
  V2SchedulerHooks,
  | "onTriggerActivated"
  | "onNodeStart"
  | "onNodeWaiting"
  | "onNodeFinish"
  | "onNodeSkipped"
  | "observationHooksFor"
> & {
  finalize(reason: string): Promise<void>;
};

export function buildV2ReplayGraphSnapshot(
  definition: WorkflowDefinitionV2,
): WorkflowReplayGraphSnapshot {
  return {
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name ?? null,
      x: node.x,
      y: node.y,
    })),
    edges: definition.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      fromPort: edge.fromPort ?? null,
    })),
  };
}

/**
 * Replay snapshots cross from workflow execution into persistence here. Keep
 * presentation redaction and size policy above the statement-only repository.
 */
export function sanitizeV2ReplaySnapshotForCapture(input: {
  graph: WorkflowReplayGraphSnapshot;
  layout: WorkflowReplayLayoutSnapshot;
  secrets: readonly string[];
}): {
  graph: WorkflowReplayGraphSnapshot;
  layout: WorkflowReplayLayoutSnapshot;
} | null {
  const graph = sanitizeReplayGraphSnapshot(input.graph, input.secrets);
  const layout = sanitizeReplayLayoutSnapshot(input.layout, input.secrets);
  return graph && layout ? { graph, layout } : null;
}

function safeSelectedTransition(
  transition: WorkflowReplaySelectedTransition | null | undefined,
): WorkflowReplaySelectedTransition | null {
  if (
    !transition ||
    transition.port.length < 1 ||
    transition.port.length > MAX_TRANSITION_IDENTIFIER_CHARACTERS ||
    transition.edgeIds.length > MAX_SELECTED_EDGE_IDS ||
    transition.edgeIds.some(
      (edgeId) =>
        edgeId.length < 1 ||
        edgeId.length > MAX_TRANSITION_IDENTIFIER_CHARACTERS,
    )
  ) {
    return null;
  }
  return { port: transition.port, edgeIds: [...transition.edgeIds] };
}

function applyReplayAttemptObservations(
  current: ReplayAttemptEnvelopeSet,
  observations: readonly ReplayAttemptObservation[],
): ReplayAttemptEnvelopeSet {
  const next = { ...current };
  for (const observation of observations) {
    const envelope = structuredClone(observation.envelope);
    switch (observation.kind) {
      case "input":
        next.input = envelope;
        break;
      case "output":
        next.output = envelope;
        break;
      case "log":
        next.logs = appendReplayLogEnvelope(next.logs, envelope);
        break;
      case "metadata":
        next.metadata = envelope;
        break;
    }
  }
  return next;
}

function boundedReplayAttemptEnvelopes(
  current: ReplayAttemptPersistenceState,
  observations: readonly ReplayAttemptObservation[],
  outcome: ReplayAttemptOutcome | null,
  selectedTransition: WorkflowReplaySelectedTransition | null,
): ReplayAttemptEnvelopeSet {
  const extraBytes = Buffer.byteLength(
    JSON.stringify({ outcome, selectedTransition }),
    "utf8",
  );
  return enforceReplayAttemptStorageBudget(
    applyReplayAttemptObservations(
      {
        input: current.inputEnvelope,
        output: current.outputEnvelope,
        logs: current.logEnvelope,
        metadata: current.metadataEnvelope,
      },
      observations,
    ),
    Math.max(1024, REPLAY_ATTEMPT_MAX_BYTES - ATTEMPT_ROW_BUDGET_OVERHEAD - extraBytes),
  );
}

function preparedReplayAttemptPersistence(
  current: ReplayAttemptPersistenceState,
  input: {
    state: ReplayAttemptState;
    outcome: ReplayAttemptOutcome | null;
    selectedTransition: WorkflowReplaySelectedTransition | null;
    diagnosticId: string | null;
    observations: readonly ReplayAttemptObservation[];
    completedAt: Date | null | undefined;
    updatedAt: Date;
  },
): PreparedReplayAttemptPersistence {
  const envelopes = boundedReplayAttemptEnvelopes(
    current,
    input.observations,
    input.outcome,
    input.selectedTransition,
  );
  return {
    expectedRevision: current.observationRevision,
    state: input.state,
    outcome: input.outcome,
    selectedTransition: input.selectedTransition,
    diagnosticId: input.diagnosticId,
    inputEnvelope: envelopes.input,
    outputEnvelope: envelopes.output,
    logEnvelope: envelopes.logs,
    metadataEnvelope: envelopes.metadata,
    completedAt:
      input.completedAt === undefined ? current.completedAt : input.completedAt,
    durationMs:
      input.completedAt instanceof Date
        ? Math.max(0, input.completedAt.getTime() - current.startedAt.getTime())
        : input.completedAt === null
          ? null
          : current.durationMs,
    updatedAt: input.updatedAt,
  };
}

export function prepareReplayAttemptObservationPersistence(
  current: ReplayAttemptPersistenceState,
  observation: ReplayAttemptObservation,
  observedAt = new Date(),
): PreparedReplayAttemptPersistence {
  return preparedReplayAttemptPersistence(current, {
    state: current.state,
    outcome: current.outcome,
    selectedTransition: safeSelectedTransition(current.selectedTransition),
    diagnosticId: current.diagnosticId,
    observations: [observation],
    completedAt: undefined,
    updatedAt: observedAt,
  });
}

export function prepareReplayAttemptWaitingPersistence(
  current: ReplayAttemptPersistenceState,
  input: {
    selectedTransition: WorkflowReplaySelectedTransition | null;
    observations: readonly ReplayAttemptObservation[];
    updatedAt?: Date;
  },
): PreparedReplayAttemptPersistence {
  return preparedReplayAttemptPersistence(current, {
    state: "waiting_loop",
    outcome: current.outcome,
    selectedTransition: safeSelectedTransition(input.selectedTransition),
    diagnosticId: current.diagnosticId,
    observations: input.observations,
    completedAt: null,
    updatedAt: input.updatedAt ?? new Date(),
  });
}

export function prepareReplayAttemptFinishPersistence(
  current: ReplayAttemptPersistenceState,
  input: {
    state: Exclude<ReplayAttemptState, "running" | "waiting_loop">;
    outcome: ReplayAttemptOutcome | null | undefined;
    selectedTransition: WorkflowReplaySelectedTransition | null;
    diagnosticId: string | null;
    observations: readonly ReplayAttemptObservation[];
    completedAt: Date;
  },
): PreparedReplayAttemptPersistence {
  return preparedReplayAttemptPersistence(current, {
    state: input.state,
    outcome: sanitizeReplayAttemptOutcome(input.outcome),
    selectedTransition: safeSelectedTransition(input.selectedTransition),
    diagnosticId: input.diagnosticId,
    observations: input.observations,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
  });
}

function identityKey(identity: V2InvocationIdentity): string {
  return `${identity.activationScopeId}\0${identity.nodeId}\0${identity.attempt}`;
}

function terminalOutcome(
  runtimeState: V2InvocationTerminalState,
  status: string,
): ReplayAttemptOutcome {
  switch (runtimeState) {
    case "completed":
      return { kind: "completed", status };
    case "waiting_for_clarification":
      return { kind: "paused", status };
    case "cancelled":
      return { kind: "cancelled", status };
    case "failed":
      return { kind: "failed", status };
  }
}

function outputStatus(output: BlockOutput | undefined, fallback: string): string {
  return typeof output?.status === "string" ? output.status : fallback;
}

interface PendingAttemptCapture {
  attemptId: Promise<number | null>;
  observations: V2InvocationObservation[];
  persistenceTail: Promise<void>;
}

/**
 * Bridges scheduler lifecycle events to durable replay capture. Every sink call
 * is isolated so observation failures can never change workflow behavior, and a
 * per-run circuit breaker bounds every captured invocation, including skipped
 * nodes.
 *
 * These hooks run inside the agent's "use workflow" function, so every sink call
 * is a durable step and the order the steps are created in is what the event log
 * records. A replay re-runs this code and has to create them in the same order.
 * That is why each hook awaits its own writes instead of detaching them: a
 * detached chain lands wherever the event loop allows, and the original run and
 * its replay do not agree on that, because the original waits on real I/O where
 * the replay is served from the log. The mismatch surfaces as a replay
 * divergence and kills the run with CORRUPTED_EVENT_LOG (AIW-251).
 *
 * Awaiting buys ordering, not coupling: the chain persist() returns is already
 * caught, so it never rejects and a failed capture write can never fail the run.
 * It trips the circuit breaker and the run carries on. finalize still drains
 * whatever is outstanding once scheduler work has stopped.
 */
export function createV2RunObservationHooks(input: {
  nodeTypes: ReadonlyMap<string, WorkflowBlockType>;
  sink: V2RunObservationSink;
  maxCapturedAttempts?: number;
  clock?: () => Date;
}): V2RunObservationHooks {
  const attempts = new Map<string, PendingAttemptCapture>();
  const persistenceTasks = new Set<Promise<void>>();
  const maxCapturedAttempts =
    input.maxCapturedAttempts ?? MAX_REPLAY_ATTEMPTS_PER_RUN;
  const now = input.clock ?? (() => new Date());
  let capturedAttemptStarts = 0;
  let captureDisabled = false;
  let captureUnavailable: Promise<void> | null = null;

  const track = (task: Promise<void>): void => {
    persistenceTasks.add(task);
    void task.finally(() => persistenceTasks.delete(task));
  };

  const tripCapture = (): Promise<void> => {
    if (captureUnavailable) return captureUnavailable;
    captureDisabled = true;
    attempts.clear();
    let marker: Promise<void>;
    try {
      marker = input.sink.markUnavailable();
    } catch {
      marker = Promise.resolve();
    }
    captureUnavailable = marker.catch(() => {});
    track(captureUnavailable);
    return captureUnavailable;
  };

  const awaitCaptureUnavailable = async (): Promise<void> => {
    await captureUnavailable;
  };

  const start = (
    identity: V2InvocationIdentity,
    startedAt: Date,
  ): PendingAttemptCapture | null => {
    if (captureDisabled) return null;
    const key = identityKey(identity);
    const existing = attempts.get(key);
    if (existing) return existing;
    if (capturedAttemptStarts >= maxCapturedAttempts) {
      tripCapture();
      return null;
    }
    capturedAttemptStarts += 1;
    let attemptId: Promise<number | null>;
    try {
      attemptId = input.sink
        .start(
          {
            nodeId: identity.nodeId,
            attempt: identity.attempt,
            activationScopeId: identity.activationScopeId,
          },
          startedAt,
        )
        .then(
          async (id) => {
            if (id === null) await tripCapture();
            return id;
          },
          async () => {
            await tripCapture();
            return null;
          },
        );
    } catch {
      attemptId = tripCapture().then(() => null);
    }
    const nodeType = input.nodeTypes.get(identity.nodeId);
    const capture: PendingAttemptCapture = {
      attemptId,
      observations: [{
        kind: "metadata",
        value: {
          ...(nodeType ? { nodeType } : {}),
          activationScopeId: identity.activationScopeId,
        },
      }],
      persistenceTail: Promise.resolve(),
    };
    attempts.set(key, capture);
    return capture;
  };

  const observe = (
    capture: PendingAttemptCapture,
    observation: V2InvocationObservation,
  ): void => {
    capture.observations.push(structuredClone(observation));
  };

  // Returns the chain so callers can await it. The chain is caught below, so it
  // never rejects: awaiting it buys a deterministic position in the event log
  // without ever letting a capture write decide whether the run survives.
  const persist = (
    capture: PendingAttemptCapture,
    write: (attemptId: number) => Promise<void>,
  ): Promise<void> => {
    if (captureDisabled) return Promise.resolve();
    const observations = capture.observations.splice(0);
    const task = capture.persistenceTail
      .then(async () => {
        const attemptId = await capture.attemptId;
        if (attemptId === null || captureDisabled) return;
        for (const observation of observations) {
          if (captureDisabled) return;
          await input.sink.observe(attemptId, observation);
        }
        if (captureDisabled) return;
        await write(attemptId);
      })
      .catch(async () => {
        await tripCapture();
      });
    capture.persistenceTail = task;
    track(task);
    return task;
  };

  const finish = (
    identity: V2InvocationIdentity,
    capture: PendingAttemptCapture,
    terminal: RunObservationAttemptFinish,
    completedAt: Date,
  ): Promise<void> => {
    const task = persist(capture, (attemptId) =>
      input.sink.finish(attemptId, terminal, completedAt),
    );
    attempts.delete(identityKey(identity));
    return task;
  };

  return {
    async onTriggerActivated(event) {
      const capture = start(event, event.startedAt);
      if (!capture) {
        await awaitCaptureUnavailable();
        return;
      }
      observe(capture, { kind: "output", value: event.output });
      await finish(
        event,
        capture,
        {
          state: "completed",
          outcome: {
            kind: "completed",
            status: outputStatus(event.output, "completed"),
          },
          selectedTransition: event.selectedTransition,
          diagnosticId: null,
        },
        event.completedAt,
      );
    },
    async onNodeStart(event) {
      start(event, event.startedAt);
      await awaitCaptureUnavailable();
    },
    async onNodeWaiting(event) {
      const capture = attempts.get(identityKey(event));
      if (!capture) {
        await awaitCaptureUnavailable();
        return;
      }
      await persist(capture, (attemptId) =>
        input.sink.updateWaiting(
          attemptId,
          event.selectedTransition,
        ),
      );
    },
    async onNodeFinish(event) {
      const key = identityKey(event);
      const capture = attempts.get(key);
      if (!capture) {
        await awaitCaptureUnavailable();
        return;
      }
      await finish(
        event,
        capture,
        {
          state: event.runtimeState,
          outcome: terminalOutcome(
            event.runtimeState,
            event.runtimeState === "completed"
              ? outputStatus(event.state.output, event.state.status)
              : event.runtimeState,
          ),
          selectedTransition: event.selectedTransition,
          diagnosticId: event.state.diagnosticId ?? null,
        },
        event.completedAt,
      );
    },
    async onNodeSkipped(event) {
      const capture = start(event, event.startedAt);
      if (!capture) {
        await awaitCaptureUnavailable();
        return;
      }
      await finish(
        event,
        capture,
        {
          state: "skipped",
          outcome: { kind: "skipped", status: "skipped" },
          selectedTransition: null,
          diagnosticId: null,
        },
        event.completedAt,
      );
    },
    observationHooksFor(identity) {
      const capture = attempts.get(identityKey(identity));
      return {
        emit(observation) {
          if (!capture) return;
          observe(capture, observation);
        },
        // Goes through persist like every other write, so it inherits the whole
        // discipline: it is awaited (deterministic step order on replay), it is
        // caught (a failed flush trips the capture breaker and never the run),
        // and it queues behind the attempt's own persistence tail.
        async flush() {
          if (!capture || !input.sink.flush) return;
          const sinkFlush = input.sink.flush.bind(input.sink);
          await persist(capture, (attemptId) => sinkFlush(attemptId));
        },
      };
    },
    async finalize(reason) {
      if (captureDisabled) {
        await Promise.allSettled([...persistenceTasks]);
        return;
      }
      const openAttempts = [...attempts.entries()];
      for (const [key, capture] of openAttempts) {
        persist(capture, (attemptId) =>
          input.sink.finish(
            attemptId,
            {
              state: "cancelled",
              outcome: { kind: "cancelled", status: reason },
              selectedTransition: null,
              diagnosticId: null,
            },
            now(),
          ),
        );
        attempts.delete(key);
      }
      await Promise.allSettled([...persistenceTasks]);
    },
  };
}
