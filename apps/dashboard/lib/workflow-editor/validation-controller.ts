import type {
  WorkflowBlockContract,
  WorkflowAvailableValuesByNode,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";

export type WorkflowValidationState =
  | ValidationStatePayload<"idle">
  | ValidationStatePayload<"checking">
  | ValidationStatePayload<"valid">
  | ValidationStatePayload<"invalid">
  | ValidationStatePayload<"error">;

interface ValidationStatePayload<Status extends string> {
  status: Status;
  issues: WorkflowDefinitionValidationIssue[];
  nodeContracts: Record<string, WorkflowBlockContract>;
  availableValuesByNode: WorkflowAvailableValuesByNode;
}

export type ValidationTimer = (callback: () => void, delayMs: number) => () => void;

export interface WorkflowValidationController<T> {
  schedule(value: T): void;
  setFocused(focused: boolean): void;
  validateNow(value: T): Promise<WorkflowDefinitionValidationResponse>;
  dispose(): void;
}

export interface WorkflowValidationControllerOptions<T> {
  delayMs?: number;
  timer?: ValidationTimer;
  now?: () => number;
  validate: (
    value: T,
    signal: AbortSignal,
  ) => Promise<WorkflowDefinitionValidationResponse>;
  onState: (state: WorkflowValidationState) => void;
}

const defaultTimer: ValidationTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createWorkflowValidationController<T>(
  options: WorkflowValidationControllerOptions<T>,
): WorkflowValidationController<T> {
  const delayMs = options.delayMs ?? 5_000;
  const scheduleTimer = options.timer ?? defaultTimer;
  const now = options.now ?? Date.now;
  let generation = 0;
  let focused = false;
  let disposed = false;
  let cancelTimer: (() => void) | null = null;
  let pending: { value: T; dueAt: number; generation: number } | null = null;
  let backgroundRequest: {
    controller: AbortController;
    generation: number;
  } | null = null;
  let immediateRequest: {
    controller: AbortController;
    generation: number;
  } | null = null;
  let lastCompleted: WorkflowValidationState | null = null;

  function cancelScheduledTimer() {
    cancelTimer?.();
    cancelTimer = null;
  }

  function abortBackgroundRequest() {
    backgroundRequest?.controller.abort();
    backgroundRequest = null;
  }

  function abortImmediateRequest() {
    immediateRequest?.controller.abort();
    immediateRequest = null;
  }

  function checkingState() {
    options.onState({
      status: "checking",
      issues: lastCompleted?.issues ?? [],
      nodeContracts: lastCompleted?.nodeContracts ?? {},
      availableValuesByNode: lastCompleted?.availableValuesByNode ?? {},
    });
  }

  function applyResult(
    scheduledGeneration: number,
    result: WorkflowDefinitionValidationResponse,
  ) {
    if (disposed || generation !== scheduledGeneration) return;
    const state: WorkflowValidationState = {
      status: result.valid ? "valid" : "invalid",
      issues: result.issues,
      nodeContracts: result.nodeContracts,
      availableValuesByNode: result.availableValuesByNode,
    };
    lastCompleted = state;
    options.onState(state);
  }

  function applyError(scheduledGeneration: number, error: unknown) {
    if (disposed || generation !== scheduledGeneration) return;
    const state: WorkflowValidationState = {
      status: "error",
      issues: [
        {
          code: "deployment",
          severity: "error",
          nodeId: null,
          message: error instanceof Error ? error.message : "Unable to validate workflow",
        },
      ],
      nodeContracts: {},
      availableValuesByNode: {},
    };
    lastCompleted = state;
    options.onState(state);
  }

  function restoreAfterImmediateFailure() {
    options.onState(
      lastCompleted ?? {
        status: "idle",
        issues: [],
        nodeContracts: {},
        availableValuesByNode: {},
      },
    );
  }

  async function runValidation(
    scheduled: { value: T; generation: number },
    kind: "background" | "immediate",
  ): Promise<WorkflowDefinitionValidationResponse> {
    const request = new AbortController();
    if (kind === "background") {
      abortBackgroundRequest();
      backgroundRequest = { controller: request, generation: scheduled.generation };
    } else {
      abortBackgroundRequest();
      abortImmediateRequest();
      immediateRequest = { controller: request, generation: scheduled.generation };
    }
    checkingState();
    try {
      const result = await options.validate(scheduled.value, request.signal);
      const activeRequest = kind === "background" ? backgroundRequest : immediateRequest;
      const isCurrent =
        activeRequest?.controller === request &&
        generation === scheduled.generation &&
        !disposed;
      if (!isCurrent) {
        const error = new Error("Validation was superseded");
        error.name = "AbortError";
        throw error;
      }
      if (kind === "background") backgroundRequest = null;
      else immediateRequest = null;
      pending = null;
      applyResult(scheduled.generation, result);
      return result;
    } catch (error) {
      const activeRequest = kind === "background" ? backgroundRequest : immediateRequest;
      const isCurrent = activeRequest?.controller === request;
      if (isCurrent && kind === "background") backgroundRequest = null;
      if (isCurrent && kind === "immediate") immediateRequest = null;
      if (kind === "background" && isCurrent && !request.signal.aborted) {
        pending = null;
        applyError(scheduled.generation, error);
      }
      if (kind === "immediate" && isCurrent && !request.signal.aborted) {
        pending = null;
        restoreAfterImmediateFailure();
      }
      throw error;
    }
  }

  function armBackgroundValidation() {
    cancelScheduledTimer();
    if (disposed || focused || !pending) return;
    const scheduled = pending;
    const remainingMs = Math.max(0, scheduled.dueAt - now());
    cancelTimer = scheduleTimer(() => {
      cancelTimer = null;
      if (disposed || focused || pending?.generation !== scheduled.generation) return;
      void runValidation(scheduled, "background").catch(() => undefined);
    }, remainingMs);
  }

  return {
    schedule(value) {
      generation += 1;
      cancelScheduledTimer();
      abortBackgroundRequest();
      abortImmediateRequest();
      lastCompleted = null;
      pending = { value, dueAt: now() + delayMs, generation };
      armBackgroundValidation();
    },
    setFocused(nextFocused) {
      if (disposed || focused === nextFocused) return;
      focused = nextFocused;
      if (focused) {
        cancelScheduledTimer();
        abortBackgroundRequest();
        return;
      }
      armBackgroundValidation();
    },
    validateNow(value) {
      generation += 1;
      cancelScheduledTimer();
      pending = { value, dueAt: now(), generation };
      return runValidation(pending, "immediate");
    },
    dispose() {
      disposed = true;
      generation += 1;
      pending = null;
      cancelScheduledTimer();
      abortBackgroundRequest();
      abortImmediateRequest();
    },
  };
}
