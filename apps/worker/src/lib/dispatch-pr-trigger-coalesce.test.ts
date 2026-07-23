import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
  RunReservation,
} from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import {
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { claimSubjectRun } from "./dispatch.js";
import {
  acceptTriggerDelivery,
  coalescePendingTrigger,
  completeTriggerDelivery,
  listPendingTriggersForSubject,
  type AcceptedTriggerDelivery,
} from "./trigger-delivery-store.js";

vi.mock("../../env.js", () => ({
  env: { JIRA_PROJECT_KEY: "PROJ", COLUMN_AI: "AI" },
}));

function registry(): RunRegistryAdapter {
  const rows = new Map<string, ActiveRunEntry>();
  return {
    reserve: vi.fn(async (reservation: RunReservation) => {
      if (rows.has(reservation.subjectKey)) return false;
      const now = Date.now();
      rows.set(reservation.subjectKey, {
        ...reservation,
        runId: null,
        state: "reserved",
        createdAt: now,
        updatedAt: now,
      });
      return true;
    }),
    bindRun: vi.fn(async (subjectKey, ownerToken, runId) => {
      const current = rows.get(subjectKey);
      if (!current || current.state !== "reserved" || current.ownerToken !== ownerToken) return false;
      rows.set(subjectKey, { ...current, state: "bound", runId, updatedAt: Date.now() });
      return true;
    }),
    beginParking: vi.fn(async () => false),
    finishParking: vi.fn(async () => false),
    handoff: vi.fn(),
    get: vi.fn(async (subjectKey) => rows.get(subjectKey) ?? null),
    beginCancellation: vi.fn(async () => false),
    releaseCancellation: vi.fn(async () => false),
    releaseReservation: vi.fn(async (subjectKey, ownerToken) => {
      const current = rows.get(subjectKey);
      if (!current || current.state !== "reserved" || current.ownerToken !== ownerToken) return false;
      rows.delete(subjectKey);
      return true;
    }),
    release: vi.fn(async (subjectKey, ownerToken, runId) => {
      const current = rows.get(subjectKey);
      if (
        !current || current.state !== "bound" || current.ownerToken !== ownerToken ||
        current.runId !== runId
      ) return false;
      rows.delete(subjectKey);
      return true;
    }),
    listAll: vi.fn(async () => [...rows.values()]),
    registerSandbox: vi.fn(),
    listSandboxes: vi.fn(),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  };
}

const subject = {
  subjectKey: "pr:github:acme/app#7",
  ticketKey: null,
  kind: "pr_trigger" as const,
};

describe("PR trigger coalescing with owner-CAS", () => {
  it("coalesces while the first owner is bound and starts after its terminal release", async () => {
    const runRegistry = registry();
    let firstOwner = "";
    const first = await claimSubjectRun(subject, runRegistry, 3, {
      startWorkflow: async (ownerToken) => {
        firstOwner = ownerToken;
        return "run-1";
      },
    });
    expect(first).toEqual({
      started: true,
      runId: "run-1",
      ownerToken: firstOwner,
    });
    expect(await runRegistry.bindRun(subject.subjectKey, firstOwner, "run-1")).toBe(true);

    const secondStart = vi.fn();
    expect(
      await claimSubjectRun(subject, runRegistry, 3, { startWorkflow: secondStart }),
    ).toEqual({ started: false, reason: "already_claimed" });
    expect(secondStart).not.toHaveBeenCalled();

    expect(await runRegistry.release(subject.subjectKey, firstOwner, "run-1")).toBe(true);
    expect(
      await claimSubjectRun(subject, runRegistry, 3, {
        startWorkflow: async () => "run-2",
      }),
    ).toEqual({
      started: true,
      runId: "run-2",
      ownerToken: expect.stringMatching(/^owner:/),
    });
  });

  it("a stale predecessor cannot release a successor reservation", async () => {
    const runRegistry = registry();
    let predecessorOwner = "";
    await claimSubjectRun(subject, runRegistry, 3, {
      startWorkflow: async (ownerToken) => {
        predecessorOwner = ownerToken;
        return "run-1";
      },
    });
    await runRegistry.bindRun(subject.subjectKey, predecessorOwner, "run-1");
    await runRegistry.release(subject.subjectKey, predecessorOwner, "run-1");

    await claimSubjectRun(subject, runRegistry, 3, {
      startWorkflow: async () => "run-2",
    });
    expect(await runRegistry.release(subject.subjectKey, predecessorOwner, "run-1")).toBe(false);
    expect(await runRegistry.get(subject.subjectKey)).not.toBeNull();
  });
});

describe("PR trigger semantic dedup at the coalesce boundary", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workflowDefinitions).values({
      id: 7,
      name: "Coalesce test",
      createdById: "test",
      createdByLabel: "Test",
    });
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 7,
      version: 11,
      definition: {},
      createdById: "test",
      createdByLabel: "Test",
    });
  });

  function prReview(
    deliveryId: string,
    semanticKey: string,
  ): AcceptedTriggerDelivery {
    return {
      delivery: {
        provider: "github",
        producer: "human",
        deliveryId,
        semanticKey,
      },
      triggerType: "trigger_pr_review",
      scope: "workflow_owned",
      subjectKey: subject.subjectKey,
      ticketKey: null,
      definitionId: 7,
      definitionVersion: 11,
      pr: {
        provider: "github",
        repoPath: "acme/app",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
        headRef: "feature/x",
        headSha: "sha-1",
        baseRef: "main",
        title: "Review me",
        author: "alice",
        isDraft: false,
        review: { state: "commented", author: "human", body: "fix this" },
      },
    };
  }

  // Faithful model of dispatchTriggerEvent's accept-then-coalesce decision
  // (dispatch-trigger.ts:148-153 and :288): a duplicate (semantic or exact)
  // short-circuits without ever coalescing; a fresh delivery either becomes the
  // run on an idle subject or coalesces into the one pending successor while the
  // subject is busy.
  async function dispatch(
    accepted: AcceptedTriggerDelivery,
    subjectBusy: boolean,
  ): Promise<"started" | "coalesced" | "deduped"> {
    const durable = await acceptTriggerDelivery(db, accepted);
    if (!durable.inserted) return "deduped";
    if (subjectBusy) {
      await coalescePendingTrigger(db, durable.stored);
      return "coalesced";
    }
    await completeTriggerDelivery(db, "github", accepted.delivery.deliveryId, {
      result: "started",
      runId: `run-${accepted.delivery.deliveryId}`,
    });
    return "started";
  }

  it("accepts one run for a review fan-out and queues no successor", async () => {
    const results = [
      await dispatch(prReview("d-review", "review:99"), false),
      await dispatch(prReview("d-c1", "review:99"), true),
      await dispatch(prReview("d-c2", "review:99"), true),
    ];
    expect(results).toEqual(["started", "deduped", "deduped"]);
    expect(await listPendingTriggersForSubject(db, subject.subjectKey)).toHaveLength(0);
  });

  it("still coalesces two independent comments into at most one successor", async () => {
    const results = [
      await dispatch(prReview("d-1", "comment:1"), false),
      await dispatch(prReview("d-2", "comment:2"), true),
      await dispatch(prReview("d-3", "comment:3"), true),
    ];
    expect(results).toEqual(["started", "coalesced", "coalesced"]);
    expect(await listPendingTriggersForSubject(db, subject.subjectKey)).toHaveLength(1);
  });
});
