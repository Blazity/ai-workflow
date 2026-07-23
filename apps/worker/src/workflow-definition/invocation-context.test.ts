import { describe, expect, it, vi } from "vitest";
import {
  combineV2InvocationCancellations,
  createV2InvocationCancellationController,
  createV2InvocationContext,
  V2InvocationCancelledError,
} from "./invocation-context.js";

describe("v2 invocation context", () => {
  it("keeps invocation identity immutable while cancellation remains observable", async () => {
    const controller = createV2InvocationCancellationController();
    const emit = vi.fn();
    const context = createV2InvocationContext({
      nodeId: "review",
      attempt: 2,
      activationScopeId: "root/loop:fix:2",
      cancellation: controller.view,
      observations: { emit },
    });

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.observations)).toBe(true);
    expect(context.cancellation.cancelled).toBe(false);

    const cancelled = context.cancellation.wait();
    controller.cancel("a sibling failed");
    await cancelled;

    expect(context.cancellation.cancelled).toBe(true);
    expect(context.cancellation.reason).toBe("a sibling failed");
    expect(() => context.cancellation.throwIfCancelled()).toThrow(
      V2InvocationCancelledError,
    );
  });

  it("combines run cancellation with scheduler cancellation", async () => {
    const run = createV2InvocationCancellationController();
    const scheduler = createV2InvocationCancellationController();
    const combined = combineV2InvocationCancellations([
      run.view,
      scheduler.view,
    ]);

    const cancelled = combined.wait();
    run.cancel("run cancelled");
    await cancelled;

    expect(combined.cancelled).toBe(true);
    expect(combined.reason).toBe("run cancelled");
  });
});
