import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Adapters } from "./adapters.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";

vi.mock("../../env.js", () => ({
  env: {
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
  },
}));

const mockStart = vi.fn();
const mockGetRun = vi.fn();
vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mockStart(...args),
  getRun: (...args: any[]) => mockGetRun(...args),
}));

vi.mock("../workflows/agent.js", () => ({
  agentWorkflow: "agentWorkflow_sentinel",
}));

const mockSandboxList = vi.fn();
const mockStopTicketSandboxes = vi.fn();
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    list: (...args: any[]) => mockSandboxList(...args),
  },
}));
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopTicketSandboxes: (...args: any[]) => mockStopTicketSandboxes(...args),
}));

function makeTicket(overrides: Partial<TicketContent> = {}): TicketContent {
  return {
    id: "ticket-001",
    identifier: "PROJ-42",
    title: "Test ticket",
    description: "Some description",
    acceptanceCriteria: "AC here",
    comments: [],
    labels: [],
    trackerStatus: "AI",
    attachments: [],
    ...overrides,
  };
}

function makeAdapters(
  overrides: Partial<{
    claim: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
    getRunId: ReturnType<typeof vi.fn>;
    fetchTicket: ReturnType<typeof vi.fn>;
    findPR: ReturnType<typeof vi.fn>;
    isTicketFailed: ReturnType<typeof vi.fn>;
  }> = {},
): Adapters {
  let claimedValue: string | undefined;

  return {
    issueTracker: {
      fetchTicket:
        overrides.fetchTicket ?? vi.fn().mockResolvedValue(makeTicket()),
      moveTicket: vi.fn(),
      postComment: vi.fn(),
      searchTickets: vi.fn(),
    },
    vcs: {
      createBranch: vi.fn(),
      createPR: vi.fn(),
      push: vi.fn(),
      getPRComments: vi.fn(),
      getCheckRunResults: vi.fn().mockResolvedValue([]),
      getPRConflictStatus: vi.fn(),
      findPR: overrides.findPR ?? vi.fn().mockResolvedValue(null),
      getBranchSha: vi.fn().mockResolvedValue("abc123"),
    },
    messaging: {
      notify: vi.fn(),
    },
    runRegistry: {
      claim:
        overrides.claim ??
        vi.fn().mockImplementation(async (_key: string, value: string) => {
          claimedValue = value;
          return true;
        }),
      register: overrides.register ?? vi.fn().mockResolvedValue(undefined),
      unregister: overrides.unregister ?? vi.fn().mockResolvedValue(undefined),
      getRunId:
        overrides.getRunId ??
        vi.fn().mockImplementation(async () => claimedValue),
      listAll: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(undefined),
      isTicketFailed: overrides.isTicketFailed ?? vi.fn().mockResolvedValue(false),
      listAllFailed: vi.fn().mockResolvedValue([]),
      clearFailedMark: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("dispatchTicket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandboxList.mockResolvedValue({
      json: { sandboxes: [] },
    });
    mockStart.mockResolvedValue({ runId: "run_123" });
    mockStopTicketSandboxes.mockResolvedValue(0);
  });

  it("dispatches agentWorkflow for a ticket in configured project + AI column", async () => {
    const adapters = makeAdapters();
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: true, runId: "run_123" });
    expect(adapters.runRegistry.claim).toHaveBeenCalledWith(
      "PROJ-42",
      expect.stringMatching(/^claiming:\d+$/),
    );
    expect(adapters.issueTracker.fetchTicket).toHaveBeenCalledWith("PROJ-42");
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      "ticket-001",
    ]);
    expect(adapters.runRegistry.register).toHaveBeenCalledWith(
      "PROJ-42",
      "run_123",
    );
  });

  it("skips dispatch when ticket is no longer in AI column", async () => {
    const unregister = vi.fn().mockResolvedValue(undefined);
    const adapters = makeAdapters({
      fetchTicket: vi.fn().mockResolvedValue(makeTicket({ trackerStatus: "Backlog" })),
      unregister,
    });
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: false, reason: "not_in_ai_column" });
    expect(unregister).toHaveBeenCalledWith("PROJ-42");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("skips dispatch when ticket is outside configured Jira project key", async () => {
    const unregister = vi.fn().mockResolvedValue(undefined);
    const adapters = makeAdapters({
      fetchTicket: vi.fn().mockResolvedValue(makeTicket({ identifier: "OTHER-42" })),
      unregister,
    });
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: false, reason: "wrong_project_key" });
    expect(unregister).toHaveBeenCalledWith("PROJ-42");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns already_claimed when claim fails", async () => {
    const adapters = makeAdapters({
      claim: vi.fn().mockResolvedValue(false),
    });
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: false, reason: "already_claimed" });
    expect(adapters.issueTracker.fetchTicket).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns at_capacity when sandbox count >= max", async () => {
    mockSandboxList.mockResolvedValue({
      json: {
        sandboxes: [
          { status: "running" },
          { status: "running" },
          { status: "running" },
        ],
      },
    });
    const adapters = makeAdapters();
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 3);

    expect(result).toEqual({ started: false, reason: "at_capacity" });
    expect(adapters.runRegistry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("aborts workflow if claim was removed during dispatch", async () => {
    const mockCancel = vi.fn().mockResolvedValue(undefined);
    mockGetRun.mockReturnValue({ cancel: mockCancel });

    // getRunId returns null — claim was removed by a cancel while workflow was starting
    const adapters = makeAdapters({
      getRunId: vi.fn().mockResolvedValue(null),
    });
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: false, reason: "already_claimed" });
    expect(mockStart).toHaveBeenCalled();
    expect(mockGetRun).toHaveBeenCalledWith("run_123");
    expect(mockCancel).toHaveBeenCalled();
    expect(mockStopTicketSandboxes).toHaveBeenCalledWith("PROJ-42");
    expect(adapters.runRegistry.register).not.toHaveBeenCalled();
  });

  it("only one concurrent dispatch wins when claim is atomic", async () => {
    let claimedValue: string | null = null;
    const claim = vi
      .fn()
      .mockImplementation(async (_key: string, value: string) => {
        if (claimedValue !== null) return false;
        claimedValue = value;
        return true;
      });
    const getRunId = vi
      .fn()
      .mockImplementation(async () => claimedValue);

    const makeAdaptersForRace = () => makeAdapters({ claim, getRunId });
    const { dispatchTicket } = await import("./dispatch.js");

    const [a, b] = await Promise.all([
      dispatchTicket("PROJ-42", makeAdaptersForRace(), 5),
      dispatchTicket("PROJ-42", makeAdaptersForRace(), 5),
    ]);

    const results = [a, b];
    const winners = results.filter((r) => r.started);
    const losers = results.filter((r) => !r.started);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toBe("already_claimed");
  });

  it("unregisters claim and returns error on dispatch failure", async () => {
    const unregister = vi.fn().mockResolvedValue(undefined);
    const adapters = makeAdapters({
      fetchTicket: vi.fn().mockRejectedValue(new Error("Jira is down")),
      unregister,
    });
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: false, reason: "error" });
    expect(unregister).toHaveBeenCalledWith("PROJ-42");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("skips dispatch for previously failed tickets", async () => {
    const adapters = makeAdapters({
      isTicketFailed: vi.fn().mockResolvedValue(true),
    });
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: false, reason: "previously_failed" });
    expect(adapters.runRegistry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe("failed-ticket safeguard full loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandboxList.mockResolvedValue({ json: { sandboxes: [] } });
    mockStart.mockResolvedValue({ runId: "run_123" });
    mockStopTicketSandboxes.mockResolvedValue(0);
  });

  it("mark → skip → clear → redispatch", async () => {
    // Shared mutable state simulating Redis
    const failedMarkers = new Map<string, string>();
    let claimedValue: string | undefined;

    const registry: Adapters["runRegistry"] = {
      claim: vi.fn().mockImplementation(async (_key: string, value: string) => {
        claimedValue = value;
        return true;
      }),
      register: vi.fn().mockResolvedValue(undefined),
      getRunId: vi.fn().mockImplementation(async () => claimedValue),
      unregister: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn().mockResolvedValue([]),
      markFailed: vi.fn().mockImplementation(async (key: string, meta: any) => {
        failedMarkers.set(key, JSON.stringify(meta));
      }),
      isTicketFailed: vi.fn().mockImplementation(async (key: string) => {
        return failedMarkers.has(key);
      }),
      listAllFailed: vi.fn().mockImplementation(async () => {
        return [...failedMarkers.entries()].map(([ticketKey, raw]) => ({
          ticketKey,
          meta: JSON.parse(raw),
        }));
      }),
      clearFailedMark: vi.fn().mockImplementation(async (key: string) => {
        failedMarkers.delete(key);
      }),
    };

    const adapters = makeAdapters();
    // Replace registry with our stateful mock
    Object.assign(adapters.runRegistry, registry);

    const { dispatchTicket } = await import("./dispatch.js");
    const { reconcileRuns } = await import("./reconcile.js");

    // Step 1: Mark ticket as failed (simulates workflow catch block)
    await registry.markFailed("PROJ-42", {
      runId: "run_failed",
      error: "move failed",
      failedAt: "2026-04-02T10:00:00.000Z",
    });

    // Step 2: Dispatch is skipped because ticket is marked failed
    const skip = await dispatchTicket("PROJ-42", adapters, 5);
    expect(skip).toEqual({ started: false, reason: "previously_failed" });

    // Step 3: Human moves ticket out of AI column → reconcile clears marker
    await reconcileRuns(new Set(), registry);
    expect(failedMarkers.has("PROJ-42")).toBe(false);

    // Step 4: Ticket moved back to AI → fresh dispatch succeeds
    const success = await dispatchTicket("PROJ-42", adapters, 5);
    expect(success.started).toBe(true);
    expect(success.runId).toBe("run_123");
  });
});
