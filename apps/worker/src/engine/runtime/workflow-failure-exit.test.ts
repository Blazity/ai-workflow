import { describe, expect, it, vi } from "vitest";
import {
  handleUnhandledWorkflowError,
  handleWorkflowFailureExit,
  pullRequestRunFailureComment,
} from "./workflow-failure-exit.js";
import { runControlErrorCases } from "../blocks/support/test-support.js";

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

  // Red when: a run a pull request started moves its linked ticket back to the
  // backlog. Production: a failed autofix on PR #16 parked AWP-269 in To Do
  // while the PR was open and nothing said so on the PR.
  it("reports a pull request run's failure on the pull request and leaves the ticket where it is", async () => {
    const order: string[] = [];
    await handleWorkflowFailureExit("AWP-269", {
      logFailure: vi.fn(async () => { order.push("log"); }),
      commentFailure: vi.fn(async () => { order.push("comment"); }),
      moveTicket: vi.fn(async () => { order.push("move"); }),
      notifyTicket: vi.fn(async () => { order.push("notify"); }),
      pullRequest: { note: vi.fn(async () => { order.push("pr-note"); }) },
    });

    expect(order).toEqual(["log", "pr-note", "comment", "notify"]);
  });

  it("notes a pull request run's failure on the pull request even with no ticket linked", async () => {
    const note = vi.fn().mockResolvedValue(undefined);
    const moveTicket = vi.fn();
    await handleWorkflowFailureExit(undefined, {
      logFailure: vi.fn().mockResolvedValue(undefined),
      commentFailure: vi.fn(),
      moveTicket,
      notifyTicket: vi.fn(),
      pullRequest: { note },
    });

    expect(note).toHaveBeenCalledOnce();
    expect(moveTicket).not.toHaveBeenCalled();
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

describe("pullRequestRunFailureComment", () => {
  // Red when: the ticket comment of a failed autofix says only the reason, so
  // the person reading the ticket cannot tell which run failed or where.
  it("names the pull request and the workflow before the reason", () => {
    expect(
      pullRequestRunFailureComment({
        workflow: "Autofix PR checks v3",
        pullRequestUrl: "https://github.com/acme/api/pull/16",
        reason: "The checks stayed red after two repair cycles.",
      }),
    ).toBe(
      'The "Autofix PR checks v3" workflow run on pull request https://github.com/acme/api/pull/16 failed: The checks stayed red after two repair cycles.',
    );
  });
});
