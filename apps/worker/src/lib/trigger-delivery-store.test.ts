import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  activeRuns,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  acceptTriggerDelivery,
  acknowledgeStartedTriggerDelivery,
  coalescePendingTrigger,
  completeTriggerDelivery,
  getTriggerDelivery,
  listPendingTriggersForSubject,
  recordCandidateStartedTriggerDelivery,
  type AcceptedTriggerDelivery,
} from "./trigger-delivery-store.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowDefinitions).values({
    id: 7,
    name: "Trigger delivery test",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values([
    {
      definitionId: 7,
      version: 11,
      definition: {},
      createdById: "test",
      createdByLabel: "Test",
    },
    {
      definitionId: 7,
      version: 12,
      definition: {},
      createdById: "test",
      createdByLabel: "Test",
    },
  ]);
});

function delivery(
  deliveryId = "d-1",
  overrides: Partial<AcceptedTriggerDelivery> = {},
): AcceptedTriggerDelivery {
  return {
    delivery: { provider: "github", producer: "github-actions", deliveryId },
    triggerType: "trigger_pr_checks_failed",
    scope: "any",
    subjectKey: "pr:github:acme/api#42",
    ticketKey: null,
    definitionId: 7,
    definitionVersion: 11,
    pr: {
      provider: "github",
      repoPath: "acme/api",
      prNumber: 42,
      prUrl: "https://github.com/acme/api/pull/42",
      headRef: "feature/x",
      headSha: "sha-current",
      baseRef: "main",
      title: "Review me",
      author: "alice",
      isDraft: false,
      failedChecks: [{ name: "lint", conclusion: "failure" }],
    },
    ...overrides,
  };
}

function reviewFanout(
  deliveryId: string,
  semanticKey: string,
): AcceptedTriggerDelivery {
  const base = delivery(deliveryId, { triggerType: "trigger_pr_review" });
  return { ...base, delivery: { ...base.delivery, semanticKey } };
}

describe("provider event inbox", () => {
  it("deduplicates provider retries without changing the original version pin", async () => {
    expect((await acceptTriggerDelivery(db, delivery())).inserted).toBe(true);
    const duplicate = await acceptTriggerDelivery(
      db,
      delivery("d-1", { definitionVersion: 12 }),
    );

    expect(duplicate).toMatchObject({
      inserted: false,
      stored: { definitionVersion: 11, pending: false, result: null },
    });
  });

  it("coalesces later feedback into one newest pending event per subject", async () => {
    const first = delivery("d-1");
    const second = delivery("d-2", {
      triggerType: "trigger_pr_review",
      definitionVersion: 12,
      pr: {
        ...delivery().pr,
        review: { state: "changes_requested", author: "bob", body: "fix this" },
      },
    });
    await acceptTriggerDelivery(db, first);
    await acceptTriggerDelivery(db, second);

    await coalescePendingTrigger(db, first);
    await coalescePendingTrigger(db, second);

    const pending = await listPendingTriggersForSubject(db, first.subjectKey);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      subjectKey: first.subjectKey,
      definitionVersion: 12,
      triggerType: "trigger_pr_review",
      pr: { review: { body: "fix this" } },
    });
    expect(
      [
        await getTriggerDelivery(db, "github", "d-1"),
        await getTriggerDelivery(db, "github", "d-2"),
      ].filter((row) => row?.pending),
    ).toHaveLength(1);
  });

  it("publishes and consumes a start only for the exact active owner", async () => {
    const accepted = delivery();
    await acceptTriggerDelivery(db, accepted);
    await coalescePendingTrigger(db, accepted);
    await db.insert(activeRuns).values({
      subjectKey: accepted.subjectKey,
      ticketKey: null,
      ownerToken: "owner-1",
      runId: "run-1",
      state: "bound",
      runKind: "pr_trigger",
    });

    await expect(
      recordCandidateStartedTriggerDelivery(db, accepted, "other-owner", "run-1"),
    ).resolves.toBe(false);
    await expect(
      recordCandidateStartedTriggerDelivery(db, accepted, "owner-1", "run-1"),
    ).resolves.toBe(true);
    await expect(
      acknowledgeStartedTriggerDelivery(db, accepted, "other-run"),
    ).resolves.toBe(false);
    await expect(
      acknowledgeStartedTriggerDelivery(db, accepted, "run-1"),
    ).resolves.toBe(true);
    await expect(getTriggerDelivery(db, "github", "d-1")).resolves.toMatchObject({
      pending: false,
      result: { result: "started", runId: "run-1" },
    });
  });

  it("accepts one review fan-out: a shared semantic key returns the winner's envelope", async () => {
    const winner = await acceptTriggerDelivery(db, reviewFanout("d-review", "review:99"));
    expect(winner.inserted).toBe(true);

    const sibling = await acceptTriggerDelivery(db, reviewFanout("d-comment", "review:99"));
    expect(sibling.inserted).toBe(false);
    expect(sibling.stored.delivery.deliveryId).toBe("d-review");
    expect(sibling.stored.delivery.semanticKey).toBe("review:99");
  });

  it("resolves the semantic winner even after it has a result recorded", async () => {
    await acceptTriggerDelivery(db, reviewFanout("d-review", "review:100"));
    await completeTriggerDelivery(db, "github", "d-review", {
      result: "started",
      runId: "run-9",
    });

    const sibling = await acceptTriggerDelivery(db, reviewFanout("d-comment", "review:100"));
    expect(sibling.inserted).toBe(false);
    expect(sibling.stored).toMatchObject({
      delivery: { deliveryId: "d-review" },
      result: { result: "started", runId: "run-9" },
    });
  });

  it("inserts separately when semantic keys differ", async () => {
    const first = await acceptTriggerDelivery(db, reviewFanout("d-1", "review:1"));
    const second = await acceptTriggerDelivery(db, reviewFanout("d-2", "review:2"));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
  });

  it("never conflicts two deliveries that carry no semantic key", async () => {
    const first = await acceptTriggerDelivery(db, delivery("d-1"));
    const second = await acceptTriggerDelivery(db, delivery("d-2"));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
  });

  it("replays the original by delivery id even when a semantic key is set", async () => {
    await acceptTriggerDelivery(db, reviewFanout("d-review", "review:7"));
    const replay = await acceptTriggerDelivery(
      db,
      reviewFanout("d-review", "review:7"),
    );
    expect(replay.inserted).toBe(false);
    expect(replay.stored.delivery.deliveryId).toBe("d-review");
  });
});
