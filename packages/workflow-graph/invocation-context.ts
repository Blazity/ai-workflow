export type V2InvocationObservation =
  | { kind: "input"; value: unknown }
  | { kind: "output"; value: unknown }
  | { kind: "log"; value: unknown }
  | { kind: "metadata"; value: unknown };

export interface V2InvocationObservationHooks {
  emit(observation: V2InvocationObservation): void | Promise<void>;
  /**
   * Make everything emitted so far durably readable, before the invocation
   * ends.
   *
   * Emission alone only buffers: the capture bridge persists at a node's
   * waiting and finish events, so a block that polls for forty minutes is
   * indistinguishable from a hung run until it returns. A block whose wait is
   * the thing an operator wants to watch calls this; nothing else should, since
   * each call is a durable write.
   *
   * Optional, so a caller that only needs emit can still pass a bare object,
   * and never throwing is part of the contract: reporting is not the work.
   */
  flush?(): void | Promise<void>;
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
    flush() {},
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
      // Forwarded, not dropped. This rebuilds the hooks rather than passing
      // them through, so anything not named here is silently stripped before it
      // reaches a block: a long-polling block would call flush?.() on undefined
      // for the whole run and its progress would reach nobody.
      ...(input.observations.flush
        ? { flush: input.observations.flush.bind(input.observations) }
        : {}),
    }),
    ...(input.clarificationAnswer === undefined
      ? {}
      : { clarificationAnswer: input.clarificationAnswer }),
  });
}
