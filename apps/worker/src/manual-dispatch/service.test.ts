import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualDispatchInput } from "@shared/contracts";
import { eq } from "drizzle-orm";
import type { Adapters } from "../lib/adapters.js";
import type { Db } from "../db/client.js";
import {
  manualDispatchRequests,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { getManualDispatchRequest } from "./store.js";

const testState = vi.hoisted(() => ({
  order: [] as string[],
  runNumber: 0,
}));
const mockResolve = vi.hoisted(() => vi.fn());
const mockReserve = vi.hoisted(() => vi.fn());
const mockMove = vi.hoisted(() => vi.fn());
const mockStart = vi.hoisted(() => vi.fn());

vi.mock("../../env.js", () => ({
  env: {
    COLUMN_AI: "AI",
    JIRA_AI_TRANSITION_ID: undefined,
    MAX_CONCURRENT_AGENTS: 4,
  },
}));
vi.mock("../lib/dispatch.js", () => ({
  reserveSubjectWithinCapacity: (...args: unknown[]) => mockReserve(...args),
}));
vi.mock("../lib/ticket-transition.js", () => ({
  moveTicketForRun: (...args: unknown[]) => mockMove(...args),
}));
vi.mock("workflow/api", () => ({
  start: (...args: unknown[]) => mockStart(...args),
}));
vi.mock("../workflows/agent.js", () => ({
  agentWorkflow: "agent-workflow",
}));
vi.mock("./resolve.js", () => ({
  resolveManualDispatch: (...args: unknown[]) => mockResolve(...args),
}));

const {
  acknowledgeManualDispatchWorkflow,
  dispatchManualWorkflow,
  recoverManualDispatches,
} = await import("./service.js");

let db: Db;
let runRegistry: {
  get: ReturnType<typeof vi.fn>;
  listAll: ReturnType<typeof vi.fn>;
  listCapacityConsumers: ReturnType<typeof vi.fn>;
  releaseReservation: ReturnType<typeof vi.fn>;
};
let adapters: Adapters;

function ticketResolution(dispatchInput: ManualDispatchInput) {
  const ticketKey =
    dispatchInput.kind === "ticket" ? dispatchInput.ticketKey.trim().toUpperCase() : "AIW-173";
  return {
    definitionId: 9,
    definitionName: "Standard delivery",
    definitionVersion: 3,
    triggerNodeId: "ticket-trigger",
    triggerType: "trigger_ticket_ai" as const,
    input: { kind: "ticket" as const, ticketKey },
    inputKind: "ticket" as const,
    inputPayload: { kind: "ticket" as const, ticketKey },
    subjectKey: `ticket:jira:${ticketKey}`,
    ticketKey,
    subjectTitle: "Manual dispatch",
    currentStatus: "Backlog",
    steps: [],
  };
}

function request(
  requestId = "1b02cf6d-d510-4ae1-a26d-c22f777b1b3a",
  ticketKey = "AIW-173",
) {
  return {
    requestId,
    expectedDeployedVersion: 3,
    input: { kind: "ticket" as const, ticketKey },
  };
}

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowDefinitions).values({
    id: 9,
    name: "Standard delivery",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: 9,
    version: 3,
    definition: {
      schemaVersion: 1,
      nodes: [
        {
          id: "ticket-trigger",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          params: {},
          inputs: {},
        },
      ],
      edges: [],
    },
    createdById: "test",
    createdByLabel: "Test",
  });
  await db
    .update(workflowDefinitions)
    .set({ deployedVersion: 3 })
    .where(eq(workflowDefinitions.id, 9));

  testState.order.length = 0;
  testState.runNumber = 0;
  mockResolve.mockReset().mockImplementation(
    async ({ dispatchInput }: { dispatchInput: ManualDispatchInput }) => {
      testState.order.push("resolve");
      return ticketResolution(dispatchInput);
    },
  );
  mockReserve.mockReset().mockImplementation(async () => {
    testState.order.push("reserve");
    return "reserved";
  });
  mockMove.mockReset().mockImplementation(async () => {
    testState.order.push("move");
  });
  mockStart.mockReset().mockImplementation(async () => {
    testState.order.push("start");
    testState.runNumber += 1;
    return { runId: `run-${testState.runNumber}` };
  });
  runRegistry = {
    get: vi.fn().mockResolvedValue(null),
    listAll: vi.fn().mockResolvedValue([]),
    listCapacityConsumers: vi.fn().mockResolvedValue([]),
    releaseReservation: vi.fn().mockResolvedValue(true),
  };
  adapters = {
    issueTracker: {} as Adapters["issueTracker"],
    vcs: {} as Adapters["vcs"],
    messaging: {} as Adapters["messaging"],
    runRegistry: runRegistry as unknown as Adapters["runRegistry"],
  };
});

describe("manual dispatch durability", () => {
  it("reserves, revalidates, moves Jira, then starts the pinned workflow", async () => {
    await expect(
      dispatchManualWorkflow({
        db,
        adapters,
        definitionId: 9,
        triggerNodeId: "ticket-trigger",
        request: request(),
        actor: { id: "user-admin", label: "Karol" },
        maxConcurrentAgents: 4,
      }),
    ).resolves.toEqual({
      requestId: request().requestId,
      status: "started",
      runId: "run-1",
    });

    expect(testState.order).toEqual([
      "resolve",
      "reserve",
      "resolve",
      "move",
      "start",
    ]);
    expect(await getManualDispatchRequest(db, request().requestId)).toMatchObject({
      status: "candidate_started",
      runId: "run-1",
      actorUserId: "user-admin",
      actorLabel: "Karol",
    });
  });

  it("returns the stored candidate for an identical request without starting twice", async () => {
    const input = {
      db,
      adapters,
      definitionId: 9,
      triggerNodeId: "ticket-trigger",
      request: request(),
      actor: { id: "user-admin", label: "Karol" },
      maxConcurrentAgents: 4,
    };
    await dispatchManualWorkflow(input);
    testState.order.length = 0;

    await expect(dispatchManualWorkflow(input)).resolves.toEqual({
      requestId: request().requestId,
      status: "started",
      runId: "run-1",
    });
    expect(testState.order).toEqual(["resolve"]);
  });

  it("rejects reuse of a request ID with different normalized input", async () => {
    const base = {
      db,
      adapters,
      definitionId: 9,
      triggerNodeId: "ticket-trigger",
      actor: { id: "user-admin", label: "Karol" },
      maxConcurrentAgents: 4,
    };
    await dispatchManualWorkflow({ ...base, request: request() });

    await expect(
      dispatchManualWorkflow({
        ...base,
        request: request(request().requestId, "AIW-174"),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("rejects a deployment change before reserving the subject", async () => {
    await expect(
      dispatchManualWorkflow({
        db,
        adapters,
        definitionId: 9,
        triggerNodeId: "ticket-trigger",
        request: { ...request(), expectedDeployedVersion: 2 },
        actor: { id: "user-admin", label: "Karol" },
        maxConcurrentAgents: 4,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "deployment_changed",
    });
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("records exhausted capacity as a durable conflict", async () => {
    mockReserve.mockResolvedValueOnce("at_capacity");
    await expect(
      dispatchManualWorkflow({
        db,
        adapters,
        definitionId: 9,
        triggerNodeId: "ticket-trigger",
        request: request(),
        actor: { id: "user-admin", label: "Karol" },
        maxConcurrentAgents: 4,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "at_capacity" });
    expect(await getManualDispatchRequest(db, request().requestId)).toMatchObject({
      status: "failed",
      errorCode: "at_capacity",
    });
    expect(mockMove).not.toHaveBeenCalled();
  });

  it("records a Jira transition failure and releases the reservation", async () => {
    mockMove.mockRejectedValueOnce(new Error("transition rejected"));

    await expect(
      dispatchManualWorkflow({
        db,
        adapters,
        definitionId: 9,
        triggerNodeId: "ticket-trigger",
        request: request(),
        actor: { id: "user-admin", label: "Karol" },
        maxConcurrentAgents: 4,
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "provider_unavailable",
    });
    expect(runRegistry.releaseReservation).toHaveBeenCalledOnce();
    expect(await getManualDispatchRequest(db, request().requestId)).toMatchObject({
      status: "failed",
      errorCode: "provider_unavailable",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("recovers the pinned request after workflow start loses its response", async () => {
    mockStart.mockRejectedValueOnce(new Error("lost response"));
    const input = {
      db,
      adapters,
      definitionId: 9,
      triggerNodeId: "ticket-trigger",
      request: request(),
      actor: { id: "user-admin", label: "Karol" },
      maxConcurrentAgents: 4,
    };
    await expect(dispatchManualWorkflow(input)).resolves.toEqual({
      requestId: request().requestId,
      status: "recovering",
    });

    await expect(
      recoverManualDispatches({ db, adapters, maxConcurrentAgents: 4 }),
    ).resolves.toMatchObject({ scanned: 1, started: 1, failed: 0 });
    expect(mockResolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ definitionVersion: 3 }),
    );
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(await getManualDispatchRequest(db, request().requestId)).toMatchObject({
      status: "candidate_started",
      runId: "run-1",
    });
  });

  it("acknowledges the winning workflow only for its durable owner", async () => {
    await dispatchManualWorkflow({
      db,
      adapters,
      definitionId: 9,
      triggerNodeId: "ticket-trigger",
      request: request(),
      actor: { id: "user-admin", label: "Karol" },
      maxConcurrentAgents: 4,
    });
    const row = await getManualDispatchRequest(db, request().requestId);

    await expect(
      acknowledgeManualDispatchWorkflow(db, {
        requestId: request().requestId,
        ownerToken: "wrong-owner",
        runId: "run-loser",
      }),
    ).resolves.toBe(false);
    await expect(
      acknowledgeManualDispatchWorkflow(db, {
        requestId: request().requestId,
        ownerToken: row!.ownerToken!,
        runId: "run-1",
      }),
    ).resolves.toBe(true);
    expect(await getManualDispatchRequest(db, request().requestId)).toMatchObject({
      status: "started",
      runId: "run-1",
    });
  });

  it("migration creates the durable table with its pinned-version foreign key", async () => {
    const rows = await db.select().from(manualDispatchRequests);
    expect(rows).toEqual([]);
  });
});
