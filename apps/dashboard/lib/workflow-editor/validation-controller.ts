import type {
  WorkflowBlockContract,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";

export type WorkflowValidationState =
  | ValidationStatePayload<"checking">
  | ValidationStatePayload<"valid">
  | ValidationStatePayload<"invalid">
  | ValidationStatePayload<"error">;

interface ValidationStatePayload<Status extends string> {
  status: Status;
  issues: WorkflowDefinitionValidationIssue[];
  nodeContracts: Record<string, WorkflowBlockContract>;
}

export type ValidationTimer = (callback: () => void, delayMs: number) => () => void;

export interface WorkflowValidationController<T> {
  schedule(value: T): void;
  setFocused(focused: boolean): void;
  validateNow(value: T): Promise<WorkflowDefinitionValidationResponse>;
  dispose(): void;
}

const defaultTimer: ValidationTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createWorkflowValidationController<T>(options: {
  delayMs?: number;
  timer?: ValidationTimer;
  now?: () => number;
  validate: (value: T, signal: AbortSignal) => Promise<WorkflowDefinitionValidationResponse>;
  onState: (state: WorkflowValidationState) => void;
}): WorkflowValidationController<T> {
  const delayMs = options.delayMs ?? 5_000;
  const scheduleTimer = options.timer ?? defaultTimer;
  const now = options.now ?? Date.now;
  let generation = 0;
  let focused = false;
  let disposed = false;
  let cancelTimer: (() => void) | null = null;
  let pending: { value: T; dueAt: number; generation: number } | null = null;
  let activeRequest: {
    controller: AbortController;
    generation: number;
    kind: "background" | "immediate";
  } | null = null;

  function cancelScheduledTimer() {
    cancelTimer?.();
    cancelTimer = null;
  }

  function abortActiveRequest() {
    activeRequest?.controller.abort();
    activeRequest = null;
  }

  function checkingState() {
    options.onState({ status: "checking", issues: [], nodeContracts: {} });
  }

  function applyResult(
    scheduledGeneration: number,
    result: WorkflowDefinitionValidationResponse,
  ) {
    if (disposed || generation !== scheduledGeneration) return;
    options.onState({
      status: result.valid ? "valid" : "invalid",
      issues: result.issues,
      nodeContracts: result.nodeContracts,
    });
  }

  function applyError(scheduledGeneration: number, error: unknown) {
    if (disposed || generation !== scheduledGeneration) return;
    options.onState({
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
    });
  }

  async function runValidation(
    scheduled: { value: T; generation: number },
    kind: "background" | "immediate",
  ): Promise<WorkflowDefinitionValidationResponse> {
    abortActiveRequest();
    const request = new AbortController();
    activeRequest = {
      controller: request,
      generation: scheduled.generation,
      kind,
    };
    try {
      const result = await options.validate(scheduled.value, request.signal);
      const isCurrent =
        activeRequest?.controller === request &&
        generation === scheduled.generation &&
        !disposed;
      if (!isCurrent) {
        const error = new Error("Validation was superseded");
        error.name = "AbortError";
        throw error;
      }
      activeRequest = null;
      pending = null;
      applyResult(scheduled.generation, result);
      return result;
    } catch (error) {
      const isCurrent = activeRequest?.controller === request;
      if (isCurrent) activeRequest = null;
      if (isCurrent && !request.signal.aborted) {
        pending = null;
        applyError(scheduled.generation, error);
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
      abortActiveRequest();
      pending = { value, dueAt: now() + delayMs, generation };
      checkingState();
      armBackgroundValidation();
    },
    setFocused(nextFocused) {
      if (disposed || focused === nextFocused) return;
      focused = nextFocused;
      if (focused) {
        cancelScheduledTimer();
        if (activeRequest?.kind === "background") abortActiveRequest();
        return;
      }
      armBackgroundValidation();
    },
    validateNow(value) {
      generation += 1;
      cancelScheduledTimer();
      abortActiveRequest();
      pending = { value, dueAt: now(), generation };
      checkingState();
      return runValidation(pending, "immediate");
    },
    dispose() {
      disposed = true;
      generation += 1;
      pending = null;
      cancelScheduledTimer();
      abortActiveRequest();
    },
  };
}
