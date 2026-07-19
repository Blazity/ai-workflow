import { describe, expect, it, vi } from "vitest";
import {
  handleUnhandledWorkflowError,
  handleWorkflowFailureExit,
} from "./workflow-failure-exit.js";
import { runControlErrorCases } from "./blocks/test-support.js";

describe("handleWorkflowFailureExit", () => {
  it("logs a PR-only review-safe failure without touching issue tracking or messaging", async () => {
    const logFailure = vi.fn().mockResolvedValue(undefined);
    const moveTicket = vi.fn().mockResolvedValue(undefined);
    const notifyTicket = vi.fn().mockResolvedValue(undefined);

    await handleWorkflowFailureExit(undefined, { logFailure, moveTicket, notifyTicket });

    expect(logFailure).toHaveBeenCalledOnce();
    expect(moveTicket).not.toHaveBeenCalled();
    expect(notifyTicket).not.toHaveBeenCalled();
  });

  it("keeps ticket failure movement and notification while ownership is held", async () => {
    const order: string[] = [];
    await handleWorkflowFailureExit("PROJ-1", {
      logFailure: vi.fn(async () => { order.push("log"); }),
      moveTicket: vi.fn(async () => { order.push("move"); }),
      notifyTicket: vi.fn(async () => { order.push("notify"); }),
    });

    expect(order).toEqual(["log", "move", "notify"]);
  });
});

describe("handleUnhandledWorkflowError", () => {
  it.each(runControlErrorCases())(
    "keeps %s out of block failure and default failure handling",
    async (_label, error) => {
      const recordBlockFailure = vi.fn();
      const applyDefaultFailure = vi.fn();

      await handleUnhandledWorkflowError(error, {
        recordBlockFailure,
        applyDefaultFailure,
      });

      expect(recordBlockFailure).not.toHaveBeenCalled();
      expect(applyDefaultFailure).not.toHaveBeenCalled();
    },
  );

  it("applies ordinary unhandled errors through the block and default failure path", async () => {
    const error = new Error("provider failed");
    const order: string[] = [];

    await handleUnhandledWorkflowError(error, {
      recordBlockFailure: vi.fn(async () => { order.push("block"); }),
      applyDefaultFailure: vi.fn(async () => { order.push("default"); }),
    });

    expect(order).toEqual(["block", "default"]);
  });
});
