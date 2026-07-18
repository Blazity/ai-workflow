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
    assertClarificationCheckpointAvailable: vi.fn(),
    getClarification: vi.fn(),
  };
});
const wf = vi.hoisted(() => ({ start: vi.fn() }));
const transition = vi.hoisted(() => ({ moveTicketWithIntent: vi.fn() }));

vi.mock("../../env.js", () => ({ env: { COLUMN_AI: "AI" } }));
vi.mock("workflow/api", () => ({ start: (...a: any[]) => wf.start(...a) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
vi.mock("../lib/ticket-transition.js", () => ({
  moveTicketWithIntent: (...args: any[]) => transition.moveTicketWithIntent(...args),
}));
vi.mock("./store.js", () => ({
  ClarificationStoreError: stores.ClarificationStoreError,
  answerClarification: (...a: any[]) => stores.answerClarification(...a),
  assertClarificationCheckpointAvailable: (...a: any[]) =>
    stores.assertClarificationCheckpointAvailable(...a),
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
    subjectKey: "ticket:jira:AWT-1",
    ownerToken: "owner-parked",
    runId: "run-asked",
    blockId: "implementation",
    waitingNodeId: "implementation",
    definitionId: 7,
    definitionVersion: 4,
    definitionVersionPin: 4,
    originEntry: { kind: "ticket", ticketKey: "AWT-1" },
    originTriggerNodeId: "trigger",
    originTriggerType: "trigger_ticket_ai",
    triggerPayload: { status: "fired", ticketKey: "AWT-1" },
    priorSteps: {},
    interpreterState: { attempts: {}, executions: 0 },
    budgetState: {
      activeElapsedMs: 0,
      tokensInput: 0,
      tokensCached: 0,
      tokensOutput: 0,
      tokensKnown: true,
      costNanos: 0,
      costUsd: 0,
      costKnown: true,
    },
    workspaceManifest: null,
    runtimeContext: {
      preSandboxAdditions: { research: [], implementation: [], review: [] },
    },
    sourceHeads: [],
    checkpointState: "ready",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    snapshotId: null,
    sourceSandboxId: null,
    snapshotRequestedAt: null,
    snapshotExpiresAt: null,
    cleanupState: "none",
    cleanupError: null,
    cleanupClaimedAt: null,
    successorOwnerToken: null,
    successorReservedAt: null,
    publishedAt: new Date(),
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

function makeRunRegistry(overrides: Record<string, unknown> = {}): RunRegistryAdapter {
  return {
    reserve: vi.fn().mockResolvedValue(true),
    releaseReservation: vi.fn().mockResolvedValue(true),
    listAll: vi.fn().mockResolvedValue([]),
    handoffBoundRun: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as RunRegistryAdapter;
}

function dispatch(overrides: Partial<Parameters<typeof dispatchClarificationAnswered>[0]> = {}) {
  return dispatchClarificationAnswered({
    db: {} as never,
    runRegistry: makeRunRegistry(),
    issueTracker: makeIssueTracker(),
    clarification: makeClarification(),
    answer: "Use Next.js",
    actor: { id: "u1", label: "Alice" },
    maxConcurrentAgents: 3,
    isRetry: false,
    successorOwnerToken: "owner-successor",
    ...overrides,
  });
}

describe("dispatchClarificationAnswered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stores.assertClarificationCheckpointAvailable.mockReturnValue(undefined);
    wf.start.mockResolvedValue({ runId: "run-x" });
    transition.moveTicketWithIntent.mockResolvedValue(undefined);
    stores.answerClarification.mockResolvedValue(
      makeClarification({
        status: "answered",
        answer: "Use Next.js",
        successorOwnerToken: "owner-successor",
      }),
    );
  });

  it("hands off the parked owner and starts the exactly pinned successor", async () => {
    const runRegistry = makeRunRegistry();
    const result = await dispatch({ runRegistry });

    expect(result).toEqual({ status: "started", runId: "run-x" });
    expect(runRegistry.handoffBoundRun).toHaveBeenCalledWith(
      "ticket:jira:AWT-1",
      "owner-parked",
      "run-asked",
      "owner-successor",
    );
    expect(wf.start).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      {
        kind: "clarification_answered",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner-successor",
        definitionId: 7,
        definitionVersion: 4,
        clarificationRequestId: "clar-1",
      },
    ]);
  });

  it("starts a ticketless scope:any continuation without Jira mutations", async () => {
    const clarification = makeClarification({
      ticketKey: null,
      subjectKey: "pr:github:acme/api:42",
      originEntry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        definitionId: 7,
        definitionVersion: 4,
        scope: "any",
        pr: {
          provider: "github",
          repoPath: "acme/api",
          prNumber: 42,
          prUrl: "https://github.com/acme/api/pull/42",
          headRef: "feature/42",
          headSha: "deadbeef",
          baseRef: "main",
          title: "Review me",
          author: "alice",
          isDraft: false,
        },
      },
      originTriggerNodeId: "review-trigger",
      originTriggerType: "trigger_pr_review",
    });
    stores.answerClarification.mockResolvedValue({
      ...clarification,
      status: "answered",
      answer: "Apply the review suggestion",
      successorOwnerToken: "owner-successor",
    });
    const issueTracker = makeIssueTracker();

    await expect(dispatch({ clarification, issueTracker })).resolves.toEqual({
      status: "started",
      runId: "run-x",
    });
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(transition.moveTicketWithIntent).not.toHaveBeenCalled();
    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
    expect(wf.start).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        kind: "clarification_answered",
        subjectKey: "pr:github:acme/api:42",
        ticketKey: null,
      }),
    ]);
  });

  it("orders answer CAS, owner handoff, ticket move, label removal, then start", async () => {
    const order: string[] = [];
    stores.answerClarification.mockImplementation(async () => {
      order.push("answer");
      return makeClarification({ status: "answered", successorOwnerToken: "owner-successor" });
    });
    const runRegistry = makeRunRegistry({
      handoffBoundRun: vi.fn().mockImplementation(async () => {
        order.push("handoff");
        return true;
      }),
    });
    const issueTracker = makeIssueTracker({
      updateLabels: vi.fn().mockImplementation(async () => order.push("label")),
    });
    transition.moveTicketWithIntent.mockImplementation(async () => order.push("move"));
    wf.start.mockImplementation(async () => {
      order.push("start");
      return { runId: "run-x" };
    });

    await dispatch({ runRegistry, issueTracker });

    expect(order).toEqual(["answer", "handoff", "move", "label", "start"]);
    expect(stores.answerClarification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      successorOwnerToken: "owner-successor",
    }));
    expect(transition.moveTicketWithIntent).toHaveBeenCalledWith({
      db: expect.anything(),
      issueTracker,
      ticketKey: "AWT-1",
      target: "AI",
      owner: {
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-successor",
        runId: null,
      },
    });
  });

  it("lets a concurrent answer loser exit before handoff or side effects", async () => {
    stores.answerClarification.mockRejectedValue(
      new stores.ClarificationStoreError(409, "already_answered"),
    );
    const runRegistry = makeRunRegistry();
    const issueTracker = makeIssueTracker();

    await expect(dispatch({ runRegistry, issueTracker })).rejects.toBeInstanceOf(
      stores.ClarificationStoreError,
    );
    expect(runRegistry.handoffBoundRun).not.toHaveBeenCalled();
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(transition.moveTicketWithIntent).not.toHaveBeenCalled();
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("returns conflict when the exact parked owner cannot be handed off", async () => {
    const runRegistry = makeRunRegistry({
      handoffBoundRun: vi.fn().mockResolvedValue(false),
      get: vi.fn().mockResolvedValue({
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "some-other-owner",
        runId: "run-other",
        state: "bound",
      }),
    });
    const issueTracker = makeIssueTracker();

    expect(await dispatch({ runRegistry, issueTracker })).toEqual({ status: "conflict" });
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(transition.moveTicketWithIntent).not.toHaveBeenCalled();
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("retries a durable successor reservation without trying to reclaim the subject", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Use Next.js",
      successorOwnerToken: "owner-successor",
    });
    stores.getClarification.mockResolvedValue(answered);
    const handoffBoundRun = vi.fn();
    const runRegistry = makeRunRegistry({
      handoffBoundRun,
      get: vi.fn().mockResolvedValue({
        subjectKey: answered.subjectKey,
        ticketKey: answered.ticketKey,
        ownerToken: "owner-successor",
        runId: null,
        state: "reserved",
        kind: "ticket",
        createdAt: 1,
        updatedAt: 1,
      }),
    });

    expect(await dispatch({ clarification: answered, runRegistry, isRetry: true })).toEqual({
      status: "started",
      runId: "run-x",
    });
    expect(stores.answerClarification).not.toHaveBeenCalled();
    expect(handoffBoundRun).not.toHaveBeenCalled();
  });

  it("repairs a retry that persisted the answer before owner handoff", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Use Next.js",
      successorOwnerToken: "owner-successor",
    });
    stores.getClarification.mockResolvedValue(answered);
    const handoffBoundRun = vi.fn().mockResolvedValue(true);
    const runRegistry = makeRunRegistry({
      handoffBoundRun,
      get: vi.fn().mockResolvedValue({
        subjectKey: answered.subjectKey,
        ownerToken: answered.ownerToken,
        runId: answered.runId,
        state: "bound",
      }),
    });

    expect(await dispatch({ clarification: answered, runRegistry, isRetry: true })).toEqual({
      status: "started",
      runId: "run-x",
    });
    expect(handoffBoundRun).toHaveBeenCalledWith(
      answered.subjectKey,
      answered.ownerToken,
      answered.runId,
      "owner-successor",
    );
  });

  it("recreates a released stale successor reservation during reconciliation retry", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Use Next.js",
      successorOwnerToken: "owner-successor",
    });
    stores.getClarification.mockResolvedValue(answered);
    const reserve = vi.fn().mockResolvedValue(true);
    const runRegistry = makeRunRegistry({
      reserve,
      get: vi.fn().mockResolvedValue(null),
    });

    expect(await dispatch({ clarification: answered, runRegistry, isRetry: true })).toEqual({
      status: "started",
      runId: "run-x",
    });
    expect(reserve).toHaveBeenCalledWith({
      subjectKey: answered.subjectKey,
      ticketKey: answered.ticketKey,
      ownerToken: "owner-successor",
      kind: "ticket",
    });
  });

  it("does not recreate a missing successor reservation while agent capacity is full", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Use Next.js",
      successorOwnerToken: "owner-successor",
    });
    stores.getClarification.mockResolvedValue(answered);
    const reserve = vi.fn().mockResolvedValue(true);
    const runRegistry = makeRunRegistry({
      reserve,
      get: vi.fn().mockResolvedValue(null),
      listAll: vi.fn().mockResolvedValue([
        {
          subjectKey: "ticket:jira:AWT-OTHER",
          ticketKey: "AWT-OTHER",
          ownerToken: "owner-other",
          runId: "run-other",
          state: "bound",
          kind: "ticket",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      releaseReservation: vi.fn(),
    });

    expect(
      await dispatch({
        clarification: answered,
        runRegistry,
        isRetry: true,
        maxConcurrentAgents: 1,
      }),
    ).toEqual({ status: "at_capacity" });
    expect(reserve).not.toHaveBeenCalled();
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("releases a recreated successor that loses the post-reservation capacity race", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Use Next.js",
      successorOwnerToken: "owner-successor",
    });
    stores.getClarification.mockResolvedValue(answered);
    const reservation = {
      subjectKey: answered.subjectKey,
      ticketKey: answered.ticketKey,
      ownerToken: "owner-successor",
      runId: null,
      state: "reserved" as const,
      kind: "ticket" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const releaseReservation = vi.fn().mockResolvedValue(true);
    const runRegistry = makeRunRegistry({
      reserve: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockResolvedValue(null),
      listAll: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            ...reservation,
            subjectKey: "ticket:jira:AWT-WINNER",
            ticketKey: "AWT-WINNER",
            ownerToken: "owner-winner",
            createdAt: Date.now() - 1,
            updatedAt: Date.now() - 1,
          },
          reservation,
        ]),
      releaseReservation,
    });

    expect(
      await dispatch({
        clarification: answered,
        runRegistry,
        isRetry: true,
        maxConcurrentAgents: 1,
      }),
    ).toEqual({ status: "at_capacity" });
    expect(releaseReservation).toHaveBeenCalledWith(
      answered.subjectKey,
      "owner-successor",
    );
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("keeps a bound-owner handoff capacity-neutral", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Use Next.js",
      successorOwnerToken: "owner-successor",
    });
    stores.getClarification.mockResolvedValue(answered);
    const handoffBoundRun = vi.fn().mockResolvedValue(true);
    const listAll = vi.fn().mockRejectedValue(new Error("capacity must not be read"));
    const runRegistry = makeRunRegistry({
      handoffBoundRun,
      get: vi.fn().mockResolvedValue({
        subjectKey: answered.subjectKey,
        ticketKey: answered.ticketKey,
        ownerToken: answered.ownerToken,
        runId: answered.runId,
        state: "bound",
        kind: "ticket",
        createdAt: 1,
        updatedAt: 1,
      }),
      listAll,
    });

    expect(
      await dispatch({
        clarification: answered,
        runRegistry,
        isRetry: true,
        maxConcurrentAgents: 0,
      }),
    ).toEqual({ status: "started", runId: "run-x" });
    expect(handoffBoundRun).toHaveBeenCalled();
    expect(listAll).not.toHaveBeenCalled();
  });

  it("recreates a ticket-linked PR continuation as a PR run", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Apply the review suggestion",
      successorOwnerToken: "owner-successor",
      originEntry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        ticketKey: "AWT-1",
        definitionId: 7,
        definitionVersion: 4,
        scope: "workflow_owned",
        pr: {
          provider: "github",
          repoPath: "acme/api",
          prNumber: 42,
          prUrl: "https://github.com/acme/api/pull/42",
          headRef: "codex/awt-1",
          headSha: "deadbeef",
          baseRef: "main",
          title: "Review me",
          author: "alice",
          isDraft: false,
        },
      },
    });
    stores.getClarification.mockResolvedValue(answered);
    const reserve = vi.fn().mockResolvedValue(true);
    const runRegistry = makeRunRegistry({
      reserve,
      get: vi.fn().mockResolvedValue(null),
    });

    await dispatch({ clarification: answered, runRegistry, isRetry: true });

    expect(reserve).toHaveBeenCalledWith({
      subjectKey: answered.subjectKey,
      ticketKey: answered.ticketKey,
      ownerToken: "owner-successor",
      kind: "pr_trigger",
    });
  });

  it("rejects an expired manual retry before ownership or Jira side effects", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Use Next.js",
      successorOwnerToken: "owner-successor",
      expiresAt: new Date("2026-07-17T00:00:00.000Z"),
    });
    stores.getClarification.mockResolvedValue(answered);
    stores.assertClarificationCheckpointAvailable.mockImplementation(() => {
      throw new stores.ClarificationStoreError(
        410,
        "clarification_checkpoint_expired: restart the ticket to rebuild the workspace",
      );
    });
    const runRegistry = makeRunRegistry();
    const issueTracker = makeIssueTracker();

    await expect(dispatch({
      clarification: answered,
      runRegistry,
      issueTracker,
      isRetry: true,
    })).rejects.toMatchObject({ statusCode: 410 });
    expect(runRegistry.get).not.toHaveBeenCalled();
    expect(runRegistry.reserve).not.toHaveBeenCalled();
    expect(runRegistry.handoffBoundRun).not.toHaveBeenCalled();
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("returns an already-bound winner instead of starting a duplicate candidate", async () => {
    const answered = makeClarification({
      status: "answered",
      answer: "Use Next.js",
      successorOwnerToken: "owner-successor",
    });
    stores.getClarification.mockResolvedValue(answered);
    const runRegistry = makeRunRegistry({
      get: vi.fn().mockResolvedValue({
        subjectKey: answered.subjectKey,
        ownerToken: "owner-successor",
        runId: "run-winner",
        state: "bound",
      }),
    });

    expect(await dispatch({ clarification: answered, runRegistry, isRetry: true })).toEqual({
      status: "started",
      runId: "run-winner",
    });
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("keeps the successor reservation retryable when moving the ticket fails", async () => {
    const issueTracker = makeIssueTracker();
    transition.moveTicketWithIntent.mockRejectedValue(new Error("jira move failed"));
    await expect(dispatch({ issueTracker })).rejects.toThrow("jira move failed");
    expect(wf.start).not.toHaveBeenCalled();
  });

  it("does not fail after handoff when best-effort label removal fails", async () => {
    const issueTracker = makeIssueTracker({
      updateLabels: vi.fn().mockRejectedValue(new Error("label boom")),
    });
    await expect(dispatch({ issueTracker })).resolves.toEqual({ status: "started", runId: "run-x" });
    expect(transition.moveTicketWithIntent).toHaveBeenCalled();
  });
});
