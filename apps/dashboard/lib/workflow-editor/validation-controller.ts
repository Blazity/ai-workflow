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
  dispose(): void;
}

const defaultTimer: ValidationTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createWorkflowValidationController<T>(options: {
  delayMs?: number;
  timer?: ValidationTimer;
  validate: (value: T, signal: AbortSignal) => Promise<WorkflowDefinitionValidationResponse>;
  onState: (state: WorkflowValidationState) => void;
}): WorkflowValidationController<T> {
  const delayMs = options.delayMs ?? 400;
  const scheduleTimer = options.timer ?? defaultTimer;
  let generation = 0;
  let cancelTimer: (() => void) | null = null;
  let activeRequest: AbortController | null = null;

  function cancelPending() {
    cancelTimer?.();
    cancelTimer = null;
    activeRequest?.abort();
    activeRequest = null;
  }

  return {
    schedule(value) {
      generation += 1;
      const scheduledGeneration = generation;
      cancelPending();
      options.onState({ status: "checking", issues: [], nodeContracts: {} });
      cancelTimer = scheduleTimer(() => {
        cancelTimer = null;
        const request = new AbortController();
        activeRequest = request;
        void options.validate(value, request.signal).then(
          (result) => {
            if (generation !== scheduledGeneration) return;
            activeRequest = null;
            options.onState({
              status: result.valid ? "valid" : "invalid",
              issues: result.issues,
              nodeContracts: result.nodeContracts,
            });
          },
          (error: unknown) => {
            if (generation !== scheduledGeneration || request.signal.aborted) return;
            activeRequest = null;
            options.onState({
              status: "error",
              issues: [
                {
                  code: "deployment",
                  nodeId: null,
                  message:
                    error instanceof Error ? error.message : "Unable to validate workflow",
                },
              ],
              nodeContracts: {},
            });
          },
        );
      }, delayMs);
    },
    dispose() {
      generation += 1;
      cancelPending();
    },
  };
}
