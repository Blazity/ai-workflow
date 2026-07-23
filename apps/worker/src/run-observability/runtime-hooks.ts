import type {
  BlockOutput,
  ReplayAttemptOutcome,
  ReplayAttemptState,
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowReplayGraphSnapshot,
  WorkflowReplaySelectedTransition,
} from "@shared/contracts";
import type { V2InvocationObservation } from "../workflow-definition/invocation-context.js";
import type {
  V2InvocationIdentity,
  V2InvocationTerminalState,
  V2SchedulerHooks,
} from "../workflow-definition/v2-scheduler.js";
import { MAX_REPLAY_ATTEMPTS_PER_RUN } from "./limits.js";

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
 * is isolated so observation failures can never change workflow behavior.
 * Attempt starts and writes run concurrently with authored work, while a
 * per-run circuit breaker bounds every captured invocation, including skipped
 * nodes. Only finalize drains persistence after scheduler work has stopped.
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

  const track = (task: Promise<void>): void => {
    persistenceTasks.add(task);
    void task.finally(() => persistenceTasks.delete(task));
  };

  const tripCapture = (): void => {
    if (captureDisabled) return;
    captureDisabled = true;
    attempts.clear();
    let marker: Promise<void>;
    try {
      marker = input.sink.markUnavailable();
    } catch {
      marker = Promise.resolve();
    }
    track(marker.catch(() => {}));
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
          (id) => {
            if (id === null) tripCapture();
            return id;
          },
          () => {
            tripCapture();
            return null;
          },
        );
    } catch {
      tripCapture();
      attemptId = Promise.resolve(null);
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

  const persist = (
    capture: PendingAttemptCapture,
    write: (attemptId: number) => Promise<void>,
  ): void => {
    if (captureDisabled) return;
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
      .catch(() => {
        tripCapture();
      });
    capture.persistenceTail = task;
    track(task);
  };

  const finish = (
    identity: V2InvocationIdentity,
    capture: PendingAttemptCapture,
    terminal: RunObservationAttemptFinish,
    completedAt: Date,
  ): void => {
    persist(capture, (attemptId) =>
      input.sink.finish(attemptId, terminal, completedAt),
    );
    attempts.delete(identityKey(identity));
  };

  return {
    onTriggerActivated(event) {
      const capture = start(event, event.startedAt);
      if (!capture) return;
      observe(capture, { kind: "output", value: event.output });
      finish(
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
    onNodeStart(event) {
      start(event, event.startedAt);
    },
    onNodeWaiting(event) {
      const capture = attempts.get(identityKey(event));
      if (!capture) return;
      persist(capture, (attemptId) =>
        input.sink.updateWaiting(
          attemptId,
          event.selectedTransition,
        ),
      );
    },
    onNodeFinish(event) {
      const key = identityKey(event);
      const capture = attempts.get(key);
      if (!capture) return;
      finish(
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
    onNodeSkipped(event) {
      const capture = start(event, event.startedAt);
      if (!capture) return;
      finish(
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
