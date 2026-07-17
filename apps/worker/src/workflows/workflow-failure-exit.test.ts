import { describe, expect, it, vi } from "vitest";
import { handleWorkflowFailureExit } from "./workflow-failure-exit.js";

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
