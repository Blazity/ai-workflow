import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { ApprovalRow } from "./store.js";

const mockStart = vi.fn();
const mockGetRun = vi.fn();
vi.mock("workflow/api", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  start: (...args: any[]) => mockStart(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRun: (...args: any[]) => mockGetRun(...args),
}));

vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));

const mockGetDefinition = vi.fn();
const mockGetVersion = vi.fn();
const mockGetCurrentVersion = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getWorkflowDefinition: (...args: any[]) => mockGetDefinition(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCurrentWorkflowDefinitionVersion: (...args: any[]) => mockGetCurrentVersion(...args),
}));

const { dispatchPlanApproved } = await import("./dispatch.js");

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

function makeRegistry(overrides: Partial<Record<keyof RunRegistryAdapter, ReturnType<typeof vi.fn>>> = {}) {
  let claimedValue: string | undefined;
  return {
    claim:
      overrides.claim ??
      vi.fn().mockImplementation(async (_key: string, value: string) => {
        claimedValue = value;
        return true;
      }),
    register: overrides.register ?? vi.fn().mockResolvedValue(undefined),
    unregister: overrides.unregister ?? vi.fn().mockResolvedValue(undefined),
    getRunId: overrides.getRunId ?? vi.fn().mockImplementation(async () => claimedValue),
    listAll: overrides.listAll ?? vi.fn().mockResolvedValue([]),
    registerSandbox: vi.fn(),
    getSandboxId: vi.fn(),
    getEntryCreatedAt: vi.fn(),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  } as unknown as RunRegistryAdapter;
}

const db = {} as never;

describe("dispatchPlanApproved", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockGetRun.mockReset();
    mockGetDefinition.mockReset();
    mockGetVersion.mockReset();
    mockGetCurrentVersion.mockReset();
    mockStart.mockResolvedValue({ runId: "run-dispatched" });
    // Definition present + not archived, pinned version resolves, head has moved on.
    mockGetDefinition.mockResolvedValue({ id: 7, archivedAt: null, enabled: false });
    mockGetVersion.mockResolvedValue({ definitionId: 7, version: 4 });
    mockGetCurrentVersion.mockResolvedValue({ definitionId: 7, version: 9 });
  });

  it("returns definition_gone when the definition is archived", async () => {
    mockGetDefinition.mockResolvedValue({ id: 7, archivedAt: new Date(), enabled: false });
    const registry = makeRegistry();
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      approval: makeApproval(),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 3,
    });
    expect(result).toEqual({ status: "definition_gone" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns definition_gone when the pinned version no longer exists", async () => {
    mockGetVersion.mockResolvedValue(null);
    const registry = makeRegistry();
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      approval: makeApproval(),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 3,
    });
    expect(result).toEqual({ status: "definition_gone" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("pins the stored version and runs it even after the head has advanced", async () => {
    // Core of the bug fix: the approval pins v4; the definition head is now v9.
    // The run must replay v4 (the version a human approved), never the head.
    const registry = makeRegistry();
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      approval: makeApproval({ definitionVersion: 4 }),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 3,
    });
    expect(result.status).toBe("started");
    expect(mockGetVersion).toHaveBeenCalledWith(expect.anything(), 7, 4);
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({ definitionId: 7, definitionVersion: 4 }),
    ]);
  });

  it("falls back to the head version for a legacy null-version approval", async () => {
    const registry = makeRegistry();
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      approval: makeApproval({ definitionVersion: null }),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 3,
    });
    expect(result.status).toBe("started");
    expect(mockGetVersion).not.toHaveBeenCalled();
    expect(mockGetCurrentVersion).toHaveBeenCalledWith(expect.anything(), 7);
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({ definitionVersion: 9 }),
    ]);
  });

  it("returns run_in_flight when the ticket is already claimed", async () => {
    const registry = makeRegistry({ claim: vi.fn().mockResolvedValue(false) });
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      approval: makeApproval(),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 3,
    });
    expect(result).toEqual({ status: "run_in_flight" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns run_in_flight when already at capacity", async () => {
    const registry = makeRegistry({
      listAll: vi.fn().mockResolvedValue([
        { ticketKey: "OTH-1", runId: "run-a" },
        { ticketKey: "OTH-2", runId: "run-b" },
      ]),
    });
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      approval: makeApproval(),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 2,
    });
    expect(result).toEqual({ status: "run_in_flight" });
    expect(registry.claim).not.toHaveBeenCalled();
  });

  it("starts the workflow, verifies the claim, registers, and runs onClaimed first", async () => {
    const registry = makeRegistry();
    const order: string[] = [];
    mockStart.mockImplementation(async () => {
      order.push("start");
      return { runId: "run-dispatched" };
    });
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      approval: makeApproval(),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 3,
      onClaimed: async () => {
        order.push("commit");
      },
    });

    expect(result).toEqual({ status: "started", runId: "run-dispatched" });
    expect(order).toEqual(["commit", "start"]);
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        kind: "plan_approved",
        ticketKey: "AWT-1",
        definitionId: 7,
        definitionVersion: 4,
        approvedPlan: { markdown: "# Plan", assumptions: undefined },
        approval: expect.objectContaining({ approvalRequestId: "appr-1", approver: "Alice" }),
      }),
    ]);
    expect(registry.register).toHaveBeenCalledWith("AWT-1", "run-dispatched");
  });

  it("releases the claim and rethrows when onClaimed throws", async () => {
    const registry = makeRegistry();
    await expect(
      dispatchPlanApproved({
        db,
        runRegistry: registry,
        approval: makeApproval(),
        actor: { id: "u1", label: "Alice" },
        maxConcurrentAgents: 3,
        onClaimed: async () => {
          throw new Error("decision lost");
        },
      }),
    ).rejects.toThrow("decision lost");
    expect(registry.unregister).toHaveBeenCalledWith("AWT-1");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("releases the claim and rethrows when start throws after onClaimed", async () => {
    const registry = makeRegistry();
    mockStart.mockRejectedValue(new Error("start failed"));
    const onClaimed = vi.fn().mockResolvedValue(undefined);
    await expect(
      dispatchPlanApproved({
        db,
        runRegistry: registry,
        approval: makeApproval(),
        actor: { id: "u1", label: "Alice" },
        maxConcurrentAgents: 3,
        onClaimed,
      }),
    ).rejects.toThrow("start failed");
    expect(onClaimed).toHaveBeenCalledOnce();
    expect(registry.unregister).toHaveBeenCalledWith("AWT-1");
    expect(registry.register).not.toHaveBeenCalled();
  });

  it("aborts the started run and keeps the claim when register fails after start", async () => {
    // start() succeeded, so a failed post-start register must abort the run and
    // NOT release the claim, or a retry could launch a second run for the ticket.
    const mockCancel = vi.fn().mockResolvedValue(undefined);
    mockGetRun.mockReturnValue({ cancel: mockCancel });
    const register = vi.fn().mockRejectedValue(new Error("registry write failed"));
    const registry = makeRegistry({ register });

    await expect(
      dispatchPlanApproved({
        db,
        runRegistry: registry,
        approval: makeApproval(),
        actor: { id: "u1", label: "Alice" },
        maxConcurrentAgents: 3,
      }),
    ).rejects.toThrow("registry write failed");

    expect(mockStart).toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(3); // idempotent retry before giving up
    expect(mockGetRun).toHaveBeenCalledWith("run-dispatched");
    expect(mockCancel).toHaveBeenCalled(); // started run aborted
    expect(registry.unregister).not.toHaveBeenCalled(); // claim kept → no duplicate
  });
});
