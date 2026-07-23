export type V2InvocationObservation =
  | { kind: "input"; value: unknown }
  | { kind: "output"; value: unknown }
  | { kind: "log"; value: unknown }
  | { kind: "metadata"; value: unknown };

export interface V2InvocationObservationHooks {
  emit(observation: V2InvocationObservation): void | Promise<void>;
}

export interface V2InvocationCancellation {
  readonly cancelled: boolean;
  readonly reason: string | undefined;
  wait(): Promise<void>;
  throwIfCancelled(): void;
}

export interface V2InvocationCancellationController {
  readonly view: V2InvocationCancellation;
  cancel(reason?: string): void;
}

export class V2InvocationCancelledError extends Error {
  constructor(readonly reason: string | undefined) {
    super(reason ?? "Workflow invocation was cancelled.");
    this.name = "V2InvocationCancelledError";
  }
}

export const NOOP_V2_INVOCATION_OBSERVATIONS: V2InvocationObservationHooks =
  Object.freeze({
    emit() {},
  });

export function createV2InvocationCancellationController(): V2InvocationCancellationController {
  let cancelled = false;
  let reason: string | undefined;
  let resolveCancellation: (() => void) | undefined;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  const view: V2InvocationCancellation = Object.freeze({
    get cancelled() {
      return cancelled;
    },
    get reason() {
      return reason;
    },
    wait() {
      return cancellation;
    },
    throwIfCancelled() {
      if (cancelled) throw new V2InvocationCancelledError(reason);
    },
  });

  return Object.freeze({
    view,
    cancel(nextReason?: string) {
      if (cancelled) return;
      cancelled = true;
      reason = nextReason;
      resolveCancellation?.();
    },
  });
}

export function combineV2InvocationCancellations(
  cancellations: readonly V2InvocationCancellation[],
): V2InvocationCancellation {
  const views = [...cancellations];
  return Object.freeze({
    get cancelled() {
      return views.some((view) => view.cancelled);
    },
    get reason() {
      return views.find((view) => view.cancelled)?.reason;
    },
    async wait() {
      if (views.some((view) => view.cancelled)) return;
      await Promise.race(views.map((view) => view.wait()));
    },
    throwIfCancelled() {
      const cancelledView = views.find((view) => view.cancelled);
      if (cancelledView) {
        throw new V2InvocationCancelledError(cancelledView.reason);
      }
    },
  });
}

export interface V2InvocationContext {
  readonly nodeId: string;
  readonly attempt: number;
  readonly activationScopeId: string;
  readonly cancellation: V2InvocationCancellation;
  readonly observations: V2InvocationObservationHooks;
  readonly clarificationAnswer?: string;
}

export function createV2InvocationContext(input: V2InvocationContext): V2InvocationContext {
  return Object.freeze({
    nodeId: input.nodeId,
    attempt: input.attempt,
    activationScopeId: input.activationScopeId,
    cancellation: input.cancellation,
    observations: Object.freeze({
      emit: input.observations.emit.bind(input.observations),
    }),
    ...(input.clarificationAnswer === undefined
      ? {}
      : { clarificationAnswer: input.clarificationAnswer }),
  });
}
