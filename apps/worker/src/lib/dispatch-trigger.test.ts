import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import {
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { upsertWorkflowOwnedBranch } from "../db/queries/workflow-owned-branches.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import type { TriggerEvent } from "./trigger-events.js";
import {
  acceptTriggerDelivery,
  coalescePendingTrigger,
  deletePendingTrigger,
  getPendingTrigger,
  getTriggerDelivery,
} from "./trigger-delivery-store.js";

vi.mock("../../env.js", () => ({ env: { JIRA_PROJECT_KEY: "AIW", COLUMN_AI: "AI" } }));
const mockStart = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));

let db: Db;
let registry: PostgresRunRegistry;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowDefinitions).values({
    id: 5,
    name: "PR flow",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: 5,
    version: 12,
    definition: {},
    createdById: "test",
    createdByLabel: "Test",
  });
  registry = new PostgresRunRegistry(db);
  mockStart.mockReset().mockResolvedValue({ runId: "run-pr" });
  mockGetEnabled.mockReset();
});

function enabled(
  params: Record<string, unknown> = { scope: "workflow_owned" },
  triggerType: TriggerEvent["triggerType"] = "trigger_pr_created",
) {
  return {
    definition: { id: 5, name: "PR flow" },
    current: {
      definitionId: 5,
      version: 12,
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: triggerType, x: 0, y: 0, params, inputs: {} },
        ],
        edges: [],
      },
    },
  };
}

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    delivery: { provider: "github", producer: "alice", deliveryId: "delivery-1" },
    triggerType: "trigger_pr_created",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      headRef: "feature/owned",
      headSha: "abc123",
      baseRef: "main",
      title: "Fix",
      author: "alice",
      isDraft: false,
    },
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    db,
    runRegistry: registry,
    maxConcurrentAgents: 3,
    getCurrentHead: vi.fn().mockResolvedValue("abc123"),
    issueTracker: {
      fetchTicket: vi.fn().mockResolvedValue({ identifier: "AIW-1" }),
    },
    ...overrides,
  } as any;
}

async function correlate(publishedHeadSha = "abc123") {
  await upsertWorkflowOwnedBranch(db, {
    ticketKey: "AIW-1",
    provider: "github",
    repoPath: "acme/app",
    branchName: "feature/owned",
    publishedHeadSha,
    pr: {
      id: 7,
      url: "https://github.com/acme/app/pull/7",
      branch: "feature/owned",
    },
  });
}

describe("dispatchTriggerEvent durable envelope", () => {
  it("rejects a missing provider delivery identity before definition lookup", async () => {
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    const malformed = event({
      delivery: { provider: "github", producer: "alice", deliveryId: "" },
    });
    expect(await dispatchTriggerEvent(malformed, deps())).toEqual({
      result: "ignored_malformed_delivery",
    });
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("returns no_definition without persisting a delivery", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "no_definition" });
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toBeNull();
  });

  it("re-reads and rejects a stale head before durable acceptance", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(
      await dispatchTriggerEvent(event(), deps({ getCurrentHead: vi.fn().mockResolvedValue("new") })),
    ).toEqual({ result: "ignored_stale_head" });
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns a retryable error when the provider head cannot be read", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(
      await dispatchTriggerEvent(
        event(),
        deps({ getCurrentHead: vi.fn().mockRejectedValue(new Error("provider unavailable")) }),
      ),
    ).toEqual({ result: "error" });
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("accepts only allowlisted CI producers for failed-check triggers", async () => {
    const ciEvent = event({
      triggerType: "trigger_pr_checks_failed",
      delivery: { provider: "github", producer: "untrusted-ci", deliveryId: "ci-untrusted" },
      pr: {
        ...event().pr,
        failedChecks: [{ name: "build", conclusion: "failure" }],
      },
    });
    mockGetEnabled.mockResolvedValue(
      enabled(
        { scope: "any", producers: ["github-actions", "gitlab-ci"] },
        "trigger_pr_checks_failed",
      ),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(await dispatchTriggerEvent(ciEvent, deps())).toEqual({ result: "ignored_producer" });
    expect(await getTriggerDelivery(db, "github", "ci-untrusted")).toBeNull();
    expect(mockStart).not.toHaveBeenCalled();

    const trusted = {
      ...ciEvent,
      delivery: { ...ciEvent.delivery, producer: "github-actions", deliveryId: "ci-trusted" },
    };
    expect(await dispatchTriggerEvent(trusted, deps())).toEqual({
      result: "started",
      runId: "run-pr",
    });
  });

  it("never treats a ticket-looking branch prefix as workflow ownership", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    const prefixed = event({ pr: { ...event().pr, headRef: "blazebot/aiw-1" } });
    expect(await dispatchTriggerEvent(prefixed, deps())).toEqual({
      result: "ignored_not_workflow_owned",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("requires durable correlation plus a valid ticket and starts under the ticket subject", async () => {
    await correlate();
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        kind: "pr_trigger",
        subjectKey: "ticket:jira:AIW-1",
        ticketKey: "AIW-1",
        ownerToken: expect.stringMatching(/^owner:/),
        definitionId: 5,
        definitionVersion: 12,
        scope: "workflow_owned",
      }),
    ]);
    expect(await registry.get("ticket:jira:AIW-1")).toMatchObject({
      state: "reserved",
      runId: null,
    });
  });

  it("rejects workflow ownership after a human advances the correlated branch", async () => {
    await correlate("abc123");
    mockGetEnabled.mockResolvedValue(enabled());
    const pushedByHuman = event({ pr: { ...event().pr, headSha: "human456" } });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(
      await dispatchTriggerEvent(
        pushedByHuman,
        deps({ getCurrentHead: vi.fn().mockResolvedValue("human456") }),
      ),
    ).toEqual({ result: "ignored_not_workflow_owned" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("rejects a durable correlation whose ticket lookup is invalid", async () => {
    await correlate();
    mockGetEnabled.mockResolvedValue(enabled());
    const issueTracker = { fetchTicket: vi.fn().mockRejectedValue(new Error("not found")) };
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps({ issueTracker }))).toEqual({
      result: "ignored_not_workflow_owned",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("scope:any uses a stable synthetic subject and never calls Jira", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any", providers: ["github"] }));
    const issueTracker = { fetchTicket: vi.fn() };
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps({ issueTracker }))).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(issueTracker.fetchTicket).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        subjectKey: "pr:github:acme/app#7",
        scope: "any",
      }),
    ]);
    expect(Object.hasOwn(mockStart.mock.calls[0][1][0], "ticketKey")).toBe(false);
  });

  it("redelivery returns the stored result and never starts twice", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "started", runId: "run-pr" });
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "started", runId: "run-pr" });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("resumes an accepted delivery whose result was not stored before a crash", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await acceptTriggerDelivery(db, {
      ...event(),
      scope: "any",
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(await dispatchTriggerEvent(event(), deps())).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(mockGetEnabled).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("revalidates an accepted-but-unfinished delivery before crash recovery", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await acceptTriggerDelivery(db, {
      ...event({
        delivery: { provider: "github", producer: "alice", deliveryId: "accepted-stale" },
      }),
      scope: "any",
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(
      await dispatchTriggerEvent(
        event({
          delivery: { provider: "github", producer: "alice", deliveryId: "accepted-stale" },
        }),
        deps({ getCurrentHead: vi.fn().mockResolvedValue("new-head") }),
      ),
    ).toEqual({ result: "ignored_stale_head" });
    expect(mockStart).not.toHaveBeenCalled();
    expect(await getTriggerDelivery(db, "github", "accepted-stale")).toMatchObject({
      result: { result: "ignored_stale_head" },
    });
  });

  it("redelivery returns the original result without re-evaluating changed head or definition", async () => {
    mockGetEnabled.mockResolvedValueOnce(enabled({ scope: "any" })).mockResolvedValueOnce(null);
    const getCurrentHead = vi.fn().mockResolvedValueOnce("abc123").mockResolvedValueOnce("new-head");
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps({ getCurrentHead }))).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(await dispatchTriggerEvent(event(), deps({ getCurrentHead }))).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(mockGetEnabled).toHaveBeenCalledTimes(1);
    expect(getCurrentHead).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("durably coalesces when another owner already holds the subject", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "existing-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    expect(
      await getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).toMatchObject({ definitionVersion: 12 });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("does not re-launch when start succeeds but dispatcher pending deletion fails", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    expect(
      await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner"),
    ).toBe(true);

    mockStart.mockImplementationOnce(async (_workflow, [input]) => {
      expect(input.pendingEvent).toEqual({
        headSha: "abc123",
        triggerType: "trigger_pr_created",
        deliveryId: "delivery-1",
      });
      expect(await registry.bindRun(input.subjectKey, input.ownerToken, "run-pr")).toBe(true);
      await deletePendingTrigger(db, {
        subjectKey: input.subjectKey,
        triggerType: input.pendingEvent.triggerType,
        delivery: { ...event().delivery, deliveryId: input.pendingEvent.deliveryId },
        pr: input.pr,
      });
      return { runId: "run-pr" };
    });
    const dispatcherDelete = vi.fn().mockRejectedValue(new Error("delete failed after start"));
    expect(
      await drainOldestPendingTrigger(
        "pr:github:acme/app#7",
        deps({ deletePending: dispatcherDelete }),
      ),
    ).toEqual({ result: "started", runId: "run-pr" });
    expect(dispatcherDelete).toHaveBeenCalledOnce();
    expect(
      await registry.release(
        "pr:github:acme/app#7",
        (await registry.get("pr:github:acme/app#7"))!.ownerToken,
        "run-pr",
      ),
    ).toBe(true);
    expect(
      await drainOldestPendingTrigger("pr:github:acme/app#7", deps()),
    ).toBeNull();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("retains feedback merged while a pending successor starts", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner");

    mockStart.mockImplementationOnce(async (_workflow, [input]) => {
      await coalescePendingTrigger(db, {
        ...event({
          delivery: { provider: "github", producer: "github-actions", deliveryId: "delivery-2" },
          pr: {
            ...event().pr,
            failedChecks: [{ name: "test", conclusion: "failure" }],
          },
        }),
        scope: "any",
        subjectKey: "pr:github:acme/app#7",
        ticketKey: null,
        definitionId: 5,
        definitionVersion: 12,
      });
      expect(await registry.bindRun(input.subjectKey, input.ownerToken, "run-pr")).toBe(true);
      return { runId: "run-pr" };
    });

    expect(await drainOldestPendingTrigger("pr:github:acme/app#7", deps())).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(
      await getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).toMatchObject({ delivery: { deliveryId: "delivery-2" } });
  });

  it("retains a pending event when its current head cannot be revalidated", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner");

    expect(
      await drainOldestPendingTrigger(
        "pr:github:acme/app#7",
        deps({ getCurrentHead: vi.fn().mockRejectedValue(new Error("provider unavailable")) }),
      ),
    ).toEqual({ result: "error" });
    expect(
      await getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).not.toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });
});
