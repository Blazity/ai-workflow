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

const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));

const { dispatchPlanApproved } = await import("./dispatch.js");

function makeApproval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "appr-1",
    ticketKey: "AWT-1",
    definitionId: 7,
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
    mockGetEnabled.mockReset();
    mockStart.mockResolvedValue({ runId: "run-dispatched" });
    mockGetEnabled.mockResolvedValue({ definition: { id: 7 }, current: null });
  });

  it("returns no_enabled_definition when no plan_approved definition is enabled", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const registry = makeRegistry();
    const result = await dispatchPlanApproved({
      db,
      runRegistry: registry,
      approval: makeApproval(),
      actor: { id: "u1", label: "Alice" },
      maxConcurrentAgents: 3,
    });
    expect(result).toEqual({ status: "no_enabled_definition" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
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
});
