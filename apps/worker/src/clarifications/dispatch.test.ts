import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { ClarificationRow } from "./store.js";

const stores = vi.hoisted(() => {
  class ClarificationStoreError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    ClarificationStoreError,
    answerClarification: vi.fn(),
    getClarification: vi.fn(),
  };
});

const claim = vi.hoisted(() => ({ claimTicketRun: vi.fn() }));
const wf = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("../../env.js", () => ({ env: { COLUMN_AI: "AI" } }));
vi.mock("workflow/api", () => ({ start: (...a: any[]) => wf.start(...a) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
vi.mock("../lib/dispatch.js", () => ({
  claimTicketRun: (...a: any[]) => claim.claimTicketRun(...a),
}));
vi.mock("./store.js", () => ({
  ClarificationStoreError: stores.ClarificationStoreError,
  answerClarification: (...a: any[]) => stores.answerClarification(...a),
  getClarification: (...a: any[]) => stores.getClarification(...a),
}));

const { dispatchClarificationAnswered } = await import("./dispatch.js");

function makeIssueTracker(overrides: Partial<IssueTrackerAdapter> = {}): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn(),
    moveTicket: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(null),
    searchTickets: vi.fn(),
    updateLabels: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as IssueTrackerAdapter;
}

function makeClarification(overrides: Partial<ClarificationRow> = {}): ClarificationRow {
  return {
    id: "clar-1",
    ticketKey: "AWT-1",
    runId: "run-asked",
    blockId: null,
    definitionId: null,
    definitionVersion: null,
    questions: ["What framework?"],
    suggestedAnswers: null,
    status: "pending",
    askedAt: new Date(),
    answer: null,
    answeredById: null,
    answeredByLabel: null,
    answeredAt: null,
    dispatchedRunId: null,
    ...overrides,
  };
}

/** Faithful-enough claimTicketRun mock: invokes the guard, then startWorkflow
 *  when the guard proceeds. A guard throw propagates (we do NOT model the shared
 *  error-path swallow: the point is that dispatch itself never swallows). */
function claimRunsGuard() {
  claim.claimTicketRun.mockImplementation(async (_tk, _reg, _max, opts) => {
    const bail = await opts.postClaimGuard();
    if (bail) return bail;
    const runId = await opts.startWorkflow();
    return { started: true, runId };
  });
}

function dispatch(overrides: Partial<Parameters<typeof dispatchClarificationAnswered>[0]> = {}) {
  return dispatchClarificationAnswered({
    db: {} as never,
    runRegistry: {} as RunRegistryAdapter,
    issueTracker: makeIssueTracker(),
    clarification: makeClarification(),
    answer: "Use Next.js",
    actor: { id: "u1", label: "Alice" },
    maxConcurrentAgents: 3,
    isRetry: false,
    ...overrides,
  });
}

describe("dispatchClarificationAnswered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wf.start.mockResolvedValue({ runId: "run-x" });
    stores.answerClarification.mockResolvedValue(makeClarification({ status: "answered" }));
  });

  it("claims with kind ticket and starts the clarification_answered workflow", async () => {
    claim.claimTicketRun.mockResolvedValue({ started: true, runId: "run-x" });
    const result = await dispatch();

    expect(result).toEqual({ status: "started", runId: "run-x" });
    const [ticketKey, , max, opts] = claim.claimTicketRun.mock.calls[0];
    expect(ticketKey).toBe("AWT-1");
    expect(max).toBe(3);
    expect(opts.kind).toBe("ticket");

    // The start payload leaves definitionId unset (resume loads the head).
    const runId = await opts.startWorkflow();
    expect(runId).toBe("run-x");
    expect(wf.start).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      { kind: "clarification_answered", ticketKey: "AWT-1", clarificationRequestId: "clar-1" },
    ]);
  });

  it("under the claim runs CAS, then move, then label removal, then start (in order)", async () => {
    const order: string[] = [];
    stores.answerClarification.mockImplementation(async () => {
      order.push("cas");
      return makeClarification({ status: "answered" });
    });
    const issueTracker = makeIssueTracker({
      moveTicket: vi.fn().mockImplementation(async () => {
        order.push("move");
      }),
      updateLabels: vi.fn().mockImplementation(async () => {
        order.push("label");
      }),
    });
    wf.start.mockImplementation(async () => {
      order.push("start");
      return { runId: "run-x" };
    });
    claimRunsGuard();

    const result = await dispatch({ issueTracker });

    expect(result).toEqual({ status: "started", runId: "run-x" });
    expect(order).toEqual(["cas", "move", "label", "start"]);
    expect(issueTracker.moveTicket).toHaveBeenCalledWith("AWT-1", "AI");
    expect(issueTracker.updateLabels).toHaveBeenCalledWith("AWT-1", {
      remove: ["needs-clarification"],
    });
  });

  it("stashes and rethrows the CAS 409 without moving or starting", async () => {
    stores.answerClarification.mockRejectedValue(
      new stores.ClarificationStoreError(409, "already_answered"),
    );
    const issueTracker = makeIssueTracker();
    claimRunsGuard();

    await expect(dispatch({ issueTracker })).rejects.toBeInstanceOf(stores.ClarificationStoreError);
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("propagates a move failure and starts no run", async () => {
    const issueTracker = makeIssueTracker({
      moveTicket: vi.fn().mockRejectedValue(new Error("jira move failed")),
    });
    claimRunsGuard();

    await expect(dispatch({ issueTracker })).rejects.toThrow("jira move failed");
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("does not fail the dispatch when label removal fails after the move", async () => {
    const issueTracker = makeIssueTracker({
      moveTicket: vi.fn().mockResolvedValue(undefined),
      updateLabels: vi.fn().mockRejectedValue(new Error("label boom")),
    });
    claimRunsGuard();

    const result = await dispatch({ issueTracker });

    expect(result).toEqual({ status: "started", runId: "run-x" });
    expect(issueTracker.moveTicket).toHaveBeenCalled();
    expect(wf.start).toHaveBeenCalled();
  });

  it("retry path skips the CAS and verifies the answered row before dispatching", async () => {
    stores.getClarification.mockResolvedValue(
      makeClarification({ status: "answered", dispatchedRunId: null }),
    );
    claimRunsGuard();
    wf.start.mockResolvedValue({ runId: "run-retry" });

    const result = await dispatch({ isRetry: true });

    expect(result).toEqual({ status: "started", runId: "run-retry" });
    expect(stores.answerClarification).not.toHaveBeenCalled();
    expect(stores.getClarification).toHaveBeenCalledWith(expect.anything(), "clar-1");
  });

  it("retry path returns conflict when a run was dispatched concurrently", async () => {
    stores.getClarification.mockResolvedValue(
      makeClarification({ status: "answered", dispatchedRunId: "run-other" }),
    );
    claimRunsGuard();

    const result = await dispatch({ isRetry: true });

    expect(result).toEqual({ status: "conflict" });
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("maps at_capacity and already_claimed dispatch results", async () => {
    claim.claimTicketRun.mockResolvedValueOnce({ started: false, reason: "at_capacity" });
    expect(await dispatch()).toEqual({ status: "at_capacity" });

    claim.claimTicketRun.mockResolvedValueOnce({ started: false, reason: "already_claimed" });
    expect(await dispatch()).toEqual({ status: "already_claimed" });
  });

  it("throws when claimTicketRun reports reason error (move swept by the shared error path)", async () => {
    claim.claimTicketRun.mockResolvedValue({ started: false, reason: "error" });
    await expect(dispatch()).rejects.toThrow(/clarification_dispatch_failed/);
  });
});
