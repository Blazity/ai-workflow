import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Adapters } from "./adapters.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";


const mockStart = vi.fn();
vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mockStart(...args),
}));

vi.mock("../workflows/implementation.js", () => ({
  implementationWorkflow: "implementationWorkflow_sentinel",
}));

vi.mock("../workflows/review-fix.js", () => ({
  reviewFixWorkflow: "reviewFixWorkflow_sentinel",
}));

const mockSandboxList = vi.fn();
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    list: (...args: any[]) => mockSandboxList(...args),
  },
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
    ...overrides,
  };
}

function makeAdapters(overrides: Partial<{
  claim: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  fetchTicket: ReturnType<typeof vi.fn>;
  findPR: ReturnType<typeof vi.fn>;
}>= {}): Adapters {
  return {
    issueTracker: {
      fetchTicket: overrides.fetchTicket ?? vi.fn().mockResolvedValue(makeTicket()),
      moveTicket: vi.fn(),
      postComment: vi.fn(),
      searchTickets: vi.fn(),
    },
    vcs: {
      createBranch: vi.fn(),
      createPR: vi.fn(),
      push: vi.fn(),
      getPRComments: vi.fn(),
      getPRConflictStatus: vi.fn(),
      findPR: overrides.findPR ?? vi.fn().mockResolvedValue(null),
    },
    messaging: {
      notify: vi.fn(),
    },
    runRegistry: {
      claim: overrides.claim ?? vi.fn().mockResolvedValue(true),
      register: overrides.register ?? vi.fn().mockResolvedValue(undefined),
      unregister: overrides.unregister ?? vi.fn().mockResolvedValue(undefined),
      getRunId: vi.fn(),
      listAll: vi.fn(),
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
  });

  it("dispatches implementation workflow when no PR exists", async () => {
    const adapters = makeAdapters();
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: true, runId: "run_123" });
    expect(adapters.runRegistry.claim).toHaveBeenCalledWith("PROJ-42", "claiming");
    expect(adapters.issueTracker.fetchTicket).toHaveBeenCalledWith("PROJ-42");
    expect(adapters.vcs.findPR).toHaveBeenCalledWith("blazebot/proj-42");
    expect(mockStart).toHaveBeenCalledWith("implementationWorkflow_sentinel", ["ticket-001"]);
    expect(adapters.runRegistry.register).toHaveBeenCalledWith("PROJ-42", "run_123");
  });

  it("dispatches review-fix workflow when PR exists", async () => {
    const adapters = makeAdapters({
      findPR: vi.fn().mockResolvedValue({ id: 7, url: "https://github.com/pr/7", branch: "blazebot/proj-42" }),
    });
    const { dispatchTicket } = await import("./dispatch.js");

    const result = await dispatchTicket("PROJ-42", adapters, 5);

    expect(result).toEqual({ started: true, runId: "run_123" });
    expect(mockStart).toHaveBeenCalledWith("reviewFixWorkflow_sentinel", ["ticket-001", "blazebot/proj-42"]);
    expect(adapters.runRegistry.register).toHaveBeenCalledWith("PROJ-42", "run_123");
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
});
