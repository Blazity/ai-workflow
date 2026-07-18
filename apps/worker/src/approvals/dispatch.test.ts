import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
  RunReservation,
} from "../adapters/run-registry/types.js";
import type { ApprovalRow } from "./store.js";

vi.mock("../../env.js", () => ({ env: { COLUMN_AI: "AI" } }));
const mockStart = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));

const mockGetDefinition = vi.fn();
const mockGetVersion = vi.fn();
const mockGetDeployedVersion = vi.fn();
const mockMoveTicketWithIntent = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getWorkflowDefinition: (...args: any[]) => mockGetDefinition(...args),
  getWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
  getDeployedWorkflowDefinitionVersion: (...args: any[]) => mockGetDeployedVersion(...args),
}));
vi.mock("../lib/ticket-transition.js", () => ({
  moveTicketWithIntent: (...args: any[]) => mockMoveTicketWithIntent(...args),
}));

const { dispatchPlanApproved } = await import("./dispatch.js");
const db = {} as never;

function makeApproval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "appr-1",
    ticketKey: "AWT-1",
    definitionId: 7,
    definitionVersion: 4,
    runId: "run-produced",
    plan: { markdown: "# Plan" },
    assumptions: null,
    status: "pending",
    requestedAt: new Date(),
    requestedBy: "workflow",
    decidedById: "u1",
    decidedByLabel: "Alice",
    decidedAt: new Date(),
    dispatchedRunId: null,
    ...overrides,
  };
}

function makeRegistry(options: {
  reserveResult?: boolean;
  initial?: ActiveRunEntry[];
} = {}): RunRegistryAdapter {
  const rows = [...(options.initial ?? [])];
  const reserve = vi.fn(async (reservation: RunReservation) => {
    if (options.reserveResult === false || rows.some((row) => row.subjectKey === reservation.subjectKey)) {
      return false;
    }
    const now = Date.now();
    rows.push({ ...reservation, runId: null, state: "reserved", createdAt: now, updatedAt: now });
    return true;
  });
  const releaseReservation = vi.fn(async (subjectKey: string, ownerToken: string) => {
    const index = rows.findIndex(
      (row) => row.subjectKey === subjectKey && row.ownerToken === ownerToken && row.state === "reserved",
    );
    if (index < 0) return false;
    rows.splice(index, 1);
    return true;
  });
  return {
    reserve,
    bindRun: vi.fn(),
    handoff: vi.fn(),
    get: vi.fn(),
    beginCancellation: vi.fn(),
    releaseCancellation: vi.fn(),
    releaseReservation,
    release: vi.fn(),
    listAll: vi.fn(async () => [...rows]),
    registerSandbox: vi.fn(),
    listSandboxes: vi.fn(),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  };
}

function active(subjectKey = "ticket:jira:OTHER-1"): ActiveRunEntry {
  return {
    subjectKey,
    ticketKey: "OTHER-1",
    ownerToken: "owner:existing",
    runId: "run-existing",
    state: "bound",
    kind: "ticket",
    createdAt: 1,
    updatedAt: 1,
  };
}

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

function dispatch(registry: RunRegistryAdapter, issueTracker = makeIssueTracker(), extra = {}) {
  return dispatchPlanApproved({
    db,
    runRegistry: registry,
    issueTracker,
    approval: makeApproval(),
    actor: { id: "u1", label: "Alice" },
    maxConcurrentAgents: 3,
    ...extra,
  });
}

describe("dispatchPlanApproved owner reservation", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockGetDefinition.mockReset();
    mockGetVersion.mockReset();
    mockGetDeployedVersion.mockReset();
    mockMoveTicketWithIntent.mockReset();
    mockStart.mockResolvedValue({ runId: "run-dispatched" });
    mockGetDefinition.mockResolvedValue({ id: 7, archivedAt: null, enabled: false });
    mockGetVersion.mockResolvedValue({ definitionId: 7, version: 4 });
    mockGetDeployedVersion.mockResolvedValue({ definitionId: 7, version: 8 });
    mockMoveTicketWithIntent.mockResolvedValue(undefined);
  });

  it("returns definition_gone before reservation for an archived definition", async () => {
    mockGetDefinition.mockResolvedValue({ id: 7, archivedAt: new Date() });
    const registry = makeRegistry();
    expect(await dispatch(registry)).toEqual({ status: "definition_gone" });
    expect(registry.reserve).not.toHaveBeenCalled();
  });

  it("returns definition_gone before reservation when the pinned version is unavailable", async () => {
    mockGetVersion.mockResolvedValue(null);
    const registry = makeRegistry();
    expect(await dispatch(registry)).toEqual({ status: "definition_gone" });
    expect(registry.reserve).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("pins the approved version and passes immutable owner identity to the candidate", async () => {
    const registry = makeRegistry();
    expect(await dispatch(registry)).toEqual({ status: "started", runId: "run-dispatched" });
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        kind: "plan_approved",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: expect.stringMatching(/^owner:/),
        definitionId: 7,
        definitionVersion: 4,
      }),
    ]);
    const reservation = vi.mocked(registry.reserve).mock.calls[0]![0];
    expect(mockMoveTicketWithIntent).toHaveBeenCalledWith({
      db,
      issueTracker: expect.anything(),
      ticketKey: "AWT-1",
      target: "AI",
      owner: {
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: reservation.ownerToken,
        runId: null,
      },
    });
  });

  it("falls back to the deployed version for a legacy null-version approval", async () => {
    const registry = makeRegistry();
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      issueTracker: makeIssueTracker(),
      approval: makeApproval({ definitionVersion: null }),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 3,
    });
    expect(result.status).toBe("started");
    expect(mockGetVersion).not.toHaveBeenCalled();
    expect(mockGetDeployedVersion).toHaveBeenCalledWith(expect.anything(), 7);
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({ definitionVersion: 8 }),
    ]);
  });

  it("returns run_in_flight when the ticket subject is already reserved", async () => {
    const registry = makeRegistry({ reserveResult: false });
    expect(await dispatch(registry)).toEqual({ status: "run_in_flight" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns run_in_flight when capacity is already full", async () => {
    const registry = makeRegistry({ initial: [active(), active("ticket:jira:OTHER-2"), active("ticket:jira:OTHER-3")] });
    expect(await dispatch(registry)).toEqual({ status: "run_in_flight" });
    expect(registry.reserve).not.toHaveBeenCalled();
  });

  it("runs decision, move, label, and start under one retained reservation", async () => {
    const order: string[] = [];
    const issueTracker = makeIssueTracker({
      updateLabels: vi.fn(async () => { order.push("label"); }),
    });
    mockMoveTicketWithIntent.mockImplementation(async () => { order.push("move"); });
    mockStart.mockImplementation(async () => {
      order.push("start");
      return { runId: "run-dispatched" };
    });
    await dispatch(makeRegistry(), issueTracker, {
      onClaimed: async () => { order.push("decision"); },
    });
    expect(order).toEqual(["decision", "move", "label", "start"]);
  });

  it("owner-releases the unbound reservation when the protected decision throws", async () => {
    const registry = makeRegistry();
    await expect(
      dispatch(registry, makeIssueTracker(), {
        onClaimed: async () => { throw new Error("decision lost"); },
      }),
    ).rejects.toThrow("decision lost");
    const reservation = vi.mocked(registry.reserve).mock.calls[0]![0];
    expect(registry.releaseReservation).toHaveBeenCalledWith(
      reservation.subjectKey,
      reservation.ownerToken,
    );
  });

  it("owner-releases the unbound reservation when workflow start throws", async () => {
    mockStart.mockRejectedValue(new Error("start failed"));
    const registry = makeRegistry();
    await expect(dispatch(registry)).rejects.toThrow("start failed");
    const reservation = vi.mocked(registry.reserve).mock.calls[0]![0];
    expect(registry.releaseReservation).toHaveBeenCalledWith(
      reservation.subjectKey,
      reservation.ownerToken,
    );
  });

  it("propagates a move failure and starts no candidate", async () => {
    const registry = makeRegistry();
    mockMoveTicketWithIntent.mockRejectedValue(new Error("jira move failed"));
    await expect(dispatch(registry)).rejects.toThrow("jira move failed");
    expect(mockStart).not.toHaveBeenCalled();
  });
});
