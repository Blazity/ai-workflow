import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
  RunReservation,
  ThreadStore,
} from "../adapters/run-registry/types.js";
import type { Adapters } from "./adapters.js";

vi.mock("../../env.js", () => ({
  env: { JIRA_PROJECT_KEY: "PROJ", COLUMN_AI: "AI" },
}));
const mockStart = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));

vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
const mockGetEnabled = vi.fn();
const mockHasBlockingApproval = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));
vi.mock("../approvals/store.js", () => ({
  hasDispatchBlockingApprovalForTicket: (...args: any[]) =>
    mockHasBlockingApproval(...args),
}));

const { dispatchTicket, STALE_CLAIM_MS } = await import("./dispatch.js");

function entry(overrides: Partial<ActiveRunEntry> = {}): ActiveRunEntry {
  return {
    subjectKey: "ticket:jira:OTHER-1",
    ticketKey: "OTHER-1",
    ownerToken: "owner:other",
    runId: "run-other",
    state: "bound",
    kind: "ticket",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function registry(options: {
  reserveResult?: boolean;
  initial?: ActiveRunEntry[];
  listError?: Error;
  failed?: boolean;
  failedError?: Error;
  capacityEntries?: ActiveRunEntry[];
} = {}): RunRegistryAdapter & ThreadStore {
  const rows = [...(options.initial ?? [])];
  return {
    reserve: vi.fn(async (reservation: RunReservation) => {
      if (options.reserveResult === false || rows.some((row) => row.subjectKey === reservation.subjectKey)) {
        return false;
      }
      const now = Date.now();
      rows.push({ ...reservation, runId: null, state: "reserved", createdAt: now, updatedAt: now });
      return true;
    }),
    bindRun: vi.fn(),
    beginParking: vi.fn(),
    finishParking: vi.fn(),
    handoff: vi.fn(),
    get: vi.fn(async (subjectKey) => rows.find((row) => row.subjectKey === subjectKey) ?? null),
    beginCancellation: vi.fn(),
    releaseCancellation: vi.fn(),
    releaseReservation: vi.fn(async (subjectKey, ownerToken) => {
      const index = rows.findIndex(
        (row) => row.subjectKey === subjectKey && row.ownerToken === ownerToken && row.state === "reserved",
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    }),
    release: vi.fn(),
    listAll: vi.fn(async () => {
      if (options.listError) throw options.listError;
      return [...rows];
    }),
    ...(options.capacityEntries
      ? { listCapacityConsumers: vi.fn(async () => [...options.capacityEntries!]) }
      : {}),
    registerSandbox: vi.fn(),
    listSandboxes: vi.fn(),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(async () => {
      if (options.failedError) throw options.failedError;
      return options.failed ?? false;
    }),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
    getParent: vi.fn(),
    setParent: vi.fn(),
    clearParent: vi.fn(),
  };
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: "ticket-id",
    identifier: "PROJ-42",
    projectKey: "PROJ",
    title: "Implement it",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus: "AI",
    attachments: [],
    ...overrides,
  };
}

function adapters(runRegistry = registry(), ticketValue = ticket()): Adapters {
  return {
    runRegistry,
    issueTracker: {
      fetchTicket: vi.fn().mockResolvedValue(ticketValue),
      moveTicket: vi.fn(),
      postComment: vi.fn(),
      searchTickets: vi.fn(),
    },
    messaging: {} as never,
    vcs: {} as never,
  };
}

describe("dispatchTicket owner reservation", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockGetEnabled.mockReset();
    mockHasBlockingApproval.mockReset().mockResolvedValue(false);
    mockStart.mockResolvedValue({ runId: "run-started" });
    mockGetEnabled.mockResolvedValue({
      definition: { id: 7 },
      current: { definitionId: 7, version: 4 },
    });
  });

  it("does not replace a pending or approved-undispatched pinned plan", async () => {
    mockHasBlockingApproval.mockResolvedValue(true);
    const runRegistry = registry();

    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 3)).toEqual({
      started: false,
      reason: "approval_pending",
    });
    expect(mockHasBlockingApproval).toHaveBeenCalledWith(expect.anything(), "PROJ-42");
    expect(runRegistry.releaseReservation).toHaveBeenCalledOnce();
    expect(mockGetEnabled).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("reserves the normalized ticket subject and pins the deployed definition for the candidate", async () => {
    const runRegistry = registry();
    const result = await dispatchTicket("proj-42", adapters(runRegistry), 3);

    expect(result).toEqual({ started: true, runId: "run-started" });
    expect(runRegistry.reserve).toHaveBeenCalledWith({
      subjectKey: "ticket:jira:PROJ-42",
      ticketKey: "proj-42",
      ownerToken: expect.stringMatching(/^owner:/),
      kind: "ticket",
    });
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        kind: "ticket",
        subjectKey: "ticket:jira:PROJ-42",
        ticketKey: "proj-42",
        ownerToken: expect.stringMatching(/^owner:/),
        definitionId: 7,
        definitionVersion: 4,
      }),
    ]);
  });

  it("pins the built-in fallback selection while retaining owner identity", async () => {
    mockGetEnabled.mockResolvedValue({
      definition: { id: 1 },
      current: null,
    });
    const runRegistry = registry();

    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 3)).toEqual({
      started: true,
      runId: "run-started",
    });
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        kind: "ticket",
        subjectKey: "ticket:jira:PROJ-42",
        ownerToken: expect.stringMatching(/^owner:/),
        definitionId: 1,
        definitionVersion: "builtin_fallback",
      }),
    ]);
  });

  it("owner-releases the reservation when no deployed definition is available", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const runRegistry = registry();

    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 3)).toEqual({
      started: false,
      reason: "no_definition",
    });
    expect(runRegistry.releaseReservation).toHaveBeenCalledOnce();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("releases the reservation when the live ticket left the AI column", async () => {
    const runRegistry = registry();
    const result = await dispatchTicket(
      "PROJ-42",
      adapters(runRegistry, ticket({ trackerStatus: "Backlog" })),
      3,
    );
    expect(result).toEqual({ started: false, reason: "not_in_ai_column" });
    expect(runRegistry.releaseReservation).toHaveBeenCalledOnce();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("rejects a ticket outside the configured project", async () => {
    const result = await dispatchTicket(
      "OTHER-42",
      adapters(registry(), ticket({ identifier: "OTHER-42", projectKey: "OTHER" })),
      3,
    );
    expect(result).toEqual({ started: false, reason: "wrong_project_key" });
  });

  it("returns already_claimed when the subject reservation loses", async () => {
    const result = await dispatchTicket("PROJ-42", adapters(registry({ reserveResult: false })), 3);
    expect(result).toEqual({ started: false, reason: "already_claimed" });
  });

  it("returns at_capacity without reserving when bound capacity is full", async () => {
    const runRegistry = registry({ initial: [entry()] });
    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 1)).toEqual({
      started: false,
      reason: "at_capacity",
    });
    expect(runRegistry.reserve).not.toHaveBeenCalled();
  });

  it("admits work when the exact parked owner is absent from the capacity view", async () => {
    const parked = entry({
      subjectKey: "ticket:jira:PROJ-PARKED",
      ticketKey: "PROJ-PARKED",
      ownerToken: "owner-parked",
      runId: "run-parked",
    });
    const runRegistry = registry({ initial: [parked], capacityEntries: [] });

    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 1)).toEqual({
      started: true,
      runId: "run-started",
    });
    expect(runRegistry.listCapacityConsumers).toHaveBeenCalled();
  });

  it("ignores stale unbound reservations in capacity", async () => {
    const stale = entry({
      state: "reserved",
      runId: null,
      createdAt: Date.now() - STALE_CLAIM_MS - 1,
      updatedAt: Date.now() - STALE_CLAIM_MS - 1,
    });
    const result = await dispatchTicket("PROJ-42", adapters(registry({ initial: [stale] })), 1);
    expect(result.started).toBe(true);
  });

  it("trusts an adapter capacity view instead of reapplying the process clock", async () => {
    const databaseLiveReservation = entry({
      state: "reserved",
      runId: null,
      createdAt: Date.now() - STALE_CLAIM_MS - 1,
      updatedAt: Date.now() - STALE_CLAIM_MS - 1,
    });
    const runRegistry = registry({ capacityEntries: [databaseLiveReservation] });

    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 1)).toEqual({
      started: false,
      reason: "at_capacity",
    });
    expect(runRegistry.reserve).not.toHaveBeenCalled();
  });

  it("counts a freshly handed-off reservation by its refreshed timestamp", async () => {
    const handedOff = entry({
      state: "reserved",
      runId: null,
      ownerToken: "owner:clarification-successor",
      createdAt: Date.now() - STALE_CLAIM_MS - 1,
      updatedAt: Date.now(),
    });
    const runRegistry = registry({ initial: [handedOff] });

    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 1)).toEqual({
      started: false,
      reason: "at_capacity",
    });
    expect(runRegistry.reserve).not.toHaveBeenCalled();
  });

  it("counts a cancelling claim even when cleanup has been pending past the stale threshold", async () => {
    const cancelling = entry({
      state: "cancelling",
      createdAt: Date.now() - STALE_CLAIM_MS - 1,
      updatedAt: Date.now() - STALE_CLAIM_MS - 1,
    });
    const runRegistry = registry({ initial: [cancelling] });

    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 1)).toEqual({
      started: false,
      reason: "at_capacity",
    });
    expect(runRegistry.reserve).not.toHaveBeenCalled();
  });

  it("does not let a new reservation outrank a claim that starts cancelling during arbitration", async () => {
    const runRegistry = registry();
    const cancelling = entry({
      state: "cancelling",
      createdAt: Date.now() - STALE_CLAIM_MS - 1,
      updatedAt: Date.now(),
    });
    vi.mocked(runRegistry.listAll)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        entry({
          subjectKey: "ticket:jira:PROJ-42",
          ticketKey: "PROJ-42",
          ownerToken: "owner:candidate",
          runId: null,
          state: "reserved",
        }),
        cancelling,
      ]);

    expect(await dispatchTicket("PROJ-42", adapters(runRegistry), 1)).toEqual({
      started: false,
      reason: "at_capacity",
    });
    expect(runRegistry.releaseReservation).toHaveBeenCalledOnce();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("fails closed when registry capacity cannot be read", async () => {
    const result = await dispatchTicket(
      "PROJ-42",
      adapters(registry({ listError: new Error("registry unavailable") })),
      3,
    );
    expect(result).toEqual({ started: false, reason: "at_capacity" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("skips tickets with a durable failed marker", async () => {
    const result = await dispatchTicket("PROJ-42", adapters(registry({ failed: true })), 3);
    expect(result).toEqual({ started: false, reason: "previously_failed" });
  });

  it("returns error and owner-releases when the post-reservation ticket read fails", async () => {
    const runRegistry = registry();
    const value = adapters(runRegistry);
    vi.mocked(value.issueTracker.fetchTicket).mockRejectedValue(new Error("jira down"));
    expect(await dispatchTicket("PROJ-42", value, 3)).toEqual({
      started: false,
      reason: "error",
    });
    expect(runRegistry.releaseReservation).toHaveBeenCalledOnce();
  });

  it("allows only one of two concurrent dispatches to reserve the subject", async () => {
    const runRegistry = registry();
    const [first, second] = await Promise.all([
      dispatchTicket("PROJ-42", adapters(runRegistry), 3),
      dispatchTicket("PROJ-42", adapters(runRegistry), 3),
    ]);
    expect([first.started, second.started].sort()).toEqual([false, true]);
    expect(mockStart).toHaveBeenCalledOnce();
  });
});
