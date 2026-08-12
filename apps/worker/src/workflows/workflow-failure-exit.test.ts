import { describe, expect, it, vi } from "vitest";
import {
  handleUnhandledWorkflowError,
  handleWorkflowFailureExit,
} from "./workflow-failure-exit.js";
import { runControlErrorCases } from "./blocks/test-support.js";

describe("handleWorkflowFailureExit", () => {
  it("logs a PR-only review-safe failure without touching issue tracking or messaging", async () => {
    const logFailure = vi.fn().mockResolvedValue(undefined);
    const commentFailure = vi.fn().mockResolvedValue(undefined);
    const moveTicket = vi.fn().mockResolvedValue(undefined);
    const notifyTicket = vi.fn().mockResolvedValue(undefined);

    await handleWorkflowFailureExit(undefined, {
      logFailure,
      commentFailure,
      moveTicket,
      notifyTicket,
    });

    expect(logFailure).toHaveBeenCalledOnce();
    expect(commentFailure).not.toHaveBeenCalled();
    expect(moveTicket).not.toHaveBeenCalled();
    expect(notifyTicket).not.toHaveBeenCalled();
  });

  it("states the reason on the ticket before the backlog move fires its webhook", async () => {
    const order: string[] = [];
    await handleWorkflowFailureExit("PROJ-1", {
      logFailure: vi.fn(async () => { order.push("log"); }),
      commentFailure: vi.fn(async () => { order.push("comment"); }),
      moveTicket: vi.fn(async () => { order.push("move"); }),
      notifyTicket: vi.fn(async () => { order.push("notify"); }),
    });

    expect(order).toEqual(["log", "comment", "move", "notify"]);
  });

  it("attempts each ordinary failure side effect once without replacing the primary error", async () => {
    const logFailure = vi.fn().mockRejectedValue(new Error("log unavailable"));
    const commentFailure = vi.fn().mockRejectedValue(new Error("Jira unavailable"));
    const moveTicket = vi.fn().mockRejectedValue(new Error("Jira unavailable"));
    const notifyTicket = vi.fn().mockRejectedValue(new Error("Slack unavailable"));

    await expect(
      handleWorkflowFailureExit("PROJ-1", {
        logFailure,
        commentFailure,
        moveTicket,
        notifyTicket,
      }),
    ).resolves.toBeUndefined();

    expect(logFailure).toHaveBeenCalledOnce();
    expect(commentFailure).toHaveBeenCalledOnce();
    expect(moveTicket).toHaveBeenCalledOnce();
    expect(notifyTicket).toHaveBeenCalledOnce();
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
