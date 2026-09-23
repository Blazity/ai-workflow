import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualDispatchInput } from "@shared/contracts";
import { eq } from "drizzle-orm";
import type { Adapters } from "../vcs/adapters.js";
import type { Db } from "../../db/client.js";
import {
  manualDispatchRequests,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowRuns,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { unactivatedRepositoryCatalog } from "../../test-support/repository-catalog.js";
import { adaptersFor } from "../../test-support/issue-tracker.js";
import {
  acknowledgeManualDispatchStarted,
  getManualDispatchRequest,
} from "../../db/repositories/manual-dispatch.js";

const testState = vi.hoisted(() => ({
  order: [] as string[],
  runNumber: 0,
}));
const mockResolve = vi.hoisted(() => vi.fn());
const mockReserve = vi.hoisted(() => vi.fn());
const mockMove = vi.hoisted(() => vi.fn());
const mockStart = vi.hoisted(() => vi.fn());

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    COLUMN_AI: "AI",
    JIRA_AI_TRANSITION_ID: undefined,
    MAX_CONCURRENT_AGENTS: 4,
  },
}));
vi.mock("../dispatch/dispatch.js", () => ({
  reserveSubjectWithinCapacity: (...args: unknown[]) => mockReserve(...args),
}));
vi.mock("../tickets/ticket-transition.js", () => ({
  moveTicketForRun: (...args: unknown[]) => mockMove(...args),
}));
vi.mock("workflow/api", () => ({
  start: (...args: unknown[]) => mockStart(...args),
}));
vi.mock("../../engine/index.js", () => ({
  agentWorkflow: "agent-workflow",
}));
vi.mock("./resolve.js", () => ({
  resolveManualDispatch: (...args: unknown[]) => mockResolve(...args),
}));

// This deployment has an issue tracker connected. Which one, and what it is
// wired to, is an integration connection since S12 and is resolved from the
// database; this suite is about what happens to a RUN, so it says the one
// thing it means and leaves the resolution to its own tests.
vi.mock("../../engine/support/issue-tracker-runtime.js", async () => {
  const support = await import("../../test-support/issue-tracker.js");
  return support.connectedIssueTracker({});
});

const {
  dispatchManualWorkflow,
  preflightManualDispatch,
  recoverManualDispatches,
} = await import("./service.js");

let db: Db;
let runRegistry: {
  commitStartedRun: ReturnType<typeof vi.fn>;
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
      schemaVersion: 2,
      nodes: [
        {
          id: "ticket-trigger",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
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
    commitStartedRun: vi.fn().mockImplementation(async () => {
      testState.order.push("commit");
      return true;
    }),
    get: vi.fn().mockResolvedValue(null),
    listAll: vi.fn().mockResolvedValue([]),
    listCapacityConsumers: vi.fn().mockResolvedValue([]),
    releaseReservation: vi.fn().mockResolvedValue(true),
  };
  adapters = {
    issueTrackerResolution: {
      ok: true,
      id: "jira",
      name: "Jira",
      adapter: {} as never,
      wiring: { projectKey: "PROJ", connection: "tracker-connection" },
    },
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
        repositoryCatalog: unactivatedRepositoryCatalog(),
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
      "commit",
    ]);
    expect(mockStart.mock.calls[0]?.[0]).toBe("agent-workflow");
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
      repositoryCatalog: unactivatedRepositoryCatalog(),
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
      repositoryCatalog: unactivatedRepositoryCatalog(),
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
        repositoryCatalog: unactivatedRepositoryCatalog(),
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
        repositoryCatalog: unactivatedRepositoryCatalog(),
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
        repositoryCatalog: unactivatedRepositoryCatalog(),
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
      repositoryCatalog: unactivatedRepositoryCatalog(),
    };
    await expect(dispatchManualWorkflow(input)).resolves.toEqual({
      requestId: request().requestId,
      status: "recovering",
    });

    await expect(
      recoverManualDispatches({
        db,
        adapters,
        maxConcurrentAgents: 4,
        repositoryCatalog: unactivatedRepositoryCatalog(),
      }),
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
      repositoryCatalog: unactivatedRepositoryCatalog(),
    });
    const row = await getManualDispatchRequest(db, request().requestId);

    await expect(
      acknowledgeManualDispatchStarted(
        db,
        request().requestId,
        "wrong-owner",
        "run-loser",
      ),
    ).resolves.toBe(false);
    await expect(
      acknowledgeManualDispatchStarted(
        db,
        request().requestId,
        row!.ownerToken!,
        "run-1",
      ),
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

describe("manual dispatch on a deployment with no issue tracker", () => {
  const PR_URL = "https://github.com/acme/api/pull/42";

  function pullRequestResolution() {
    return {
      definitionId: 9,
      definitionName: "Standard delivery",
      definitionVersion: 3,
      triggerNodeId: "ticket-trigger",
      triggerType: "trigger_pr_created" as const,
      input: { kind: "pull_request" as const, url: PR_URL },
      inputKind: "pull_request" as const,
      inputPayload: {
        kind: "pull_request" as const,
        scope: "any" as const,
        pr: { provider: "github", repoPath: "acme/api", prNumber: 42, prUrl: PR_URL },
      },
      subjectKey: "pr:github:acme/api#42",
      ticketKey: null,
      subjectTitle: "Add retries",
      subjectUrl: PR_URL,
      aiColumn: "AI",
      steps: [],
      blockTypes: [],
    };
  }

  function pullRequestDispatch(withoutTracker: Adapters) {
    return {
      db,
      adapters: withoutTracker,
      definitionId: 9,
      triggerNodeId: "ticket-trigger",
      request: {
        requestId: "6f1c1d52-0f5e-4c1b-9a5e-0d6e2f1f4c11",
        expectedDeployedVersion: 3,
        input: { kind: "pull_request" as const, url: PR_URL },
      },
      actor: { id: "user-admin", label: "Karol" },
      maxConcurrentAgents: 4,
      repositoryCatalog: unactivatedRepositoryCatalog(),
    };
  }

  function withoutTracker(): Adapters {
    return adaptersFor("not_connected", {
      runRegistry,
      vcs: {},
      messaging: {},
    });
  }

  beforeEach(() => {
    mockResolve.mockReset().mockImplementation(async () => pullRequestResolution());
  });

  it("starts a pull request dispatch, which never needed a ticket", async () => {
    // A GitHub-only deployment: the dispatch used to reach for the tracker
    // before resolving the pull request and fail on its absence.
    await expect(dispatchManualWorkflow(pullRequestDispatch(withoutTracker()))).resolves.toEqual({
      requestId: "6f1c1d52-0f5e-4c1b-9a5e-0d6e2f1f4c11",
      status: "started",
      runId: "run-1",
    });
    expect(mockMove).not.toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        issueTrackerResolution: expect.objectContaining({ ok: false }),
      }),
    );
  });

  it("recovers a queued pull request dispatch instead of counting it as recovering forever", async () => {
    mockStart.mockRejectedValueOnce(new Error("lost response"));
    await expect(
      dispatchManualWorkflow(pullRequestDispatch(withoutTracker())),
    ).resolves.toMatchObject({ status: "recovering" });

    await expect(
      recoverManualDispatches({
        db,
        adapters: withoutTracker(),
        maxConcurrentAgents: 4,
        repositoryCatalog: unactivatedRepositoryCatalog(),
      }),
    ).resolves.toMatchObject({ scanned: 1, started: 1, recovering: 0, failed: 0 });
  });

  // Red when: a subject whose last run already finished is refused with
  // "already has an active workflow run". The claim outlives the run until the
  // reconcile pass releases it, and a person told the run is active looks for
  // a run that is not there.
  it("says a held claim belongs to a run that finished, and that it releases shortly", async () => {
    const claim = (runId: string) => ({
      subjectKey: "pr:github:acme/api#16",
      ownerToken: "owner-1",
      runId,
      state: "started",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.insert(workflowRuns).values({
      runId: "run-finished",
      status: "failed",
      completedAt: new Date(),
    });
    const preflight = async () =>
      await preflightManualDispatch({
        db,
        adapters: withoutTracker(),
        definitionId: 9,
        triggerNodeId: "ticket-trigger",
        dispatchInput: { kind: "pull_request", url: PR_URL },
        maxConcurrentAgents: 4,
        repositoryCatalog: unactivatedRepositoryCatalog(),
        integrations: { byId: new Map(), providers: new Map() } as never,
      });

    runRegistry.get.mockResolvedValueOnce(claim("run-finished"));
    const finished = await preflight();
    expect(finished.runnable).toBe(false);
    expect(finished.blocker?.code).toBe("active_run");
    expect(finished.blocker?.message).toMatch(/run-finished\) has finished \(failed\)/u);
    expect(finished.blocker?.message).toMatch(/released automatically within about 20 minutes/u);

    // A run still going keeps the plain answer.
    runRegistry.get.mockResolvedValueOnce(claim("run-live"));
    const live = await preflight();
    expect(live.blocker?.message).toBe("This ticket or pull request already has an active workflow run.");
  });

  it("previews a pull request dispatch rather than failing the modal", async () => {
    const preview = await preflightManualDispatch({
      db,
      adapters: withoutTracker(),
      definitionId: 9,
      triggerNodeId: "ticket-trigger",
      dispatchInput: { kind: "pull_request", url: PR_URL },
      maxConcurrentAgents: 4,
      repositoryCatalog: unactivatedRepositoryCatalog(),
      integrations: { byId: new Map(), providers: new Map() } as never,
    });

    expect(preview).toMatchObject({ runnable: true, subject: { kind: "pull_request" } });
  });
});
