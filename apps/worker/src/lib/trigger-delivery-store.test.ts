import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import type { AcceptedTriggerDelivery } from "./trigger-delivery-store.js";
import {
  acceptTriggerDelivery,
  completeTriggerDelivery,
  coalescePendingTrigger,
  deletePendingTrigger,
  getPendingTrigger,
  getTriggerDelivery,
  listPendingSubjectKeys,
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

function delivery(overrides: Partial<AcceptedTriggerDelivery> = {}): AcceptedTriggerDelivery {
  return {
    delivery: { provider: "github", producer: "github-actions", deliveryId: "d-1" },
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

describe("durable trigger deliveries", () => {
  it("accepts one provider delivery identity and returns the stored result on redelivery", async () => {
    const first = await acceptTriggerDelivery(db, delivery());
    expect(first.inserted).toBe(true);
    await completeTriggerDelivery(db, "github", "d-1", {
      result: "started",
      runId: "run-1",
    });

    const duplicate = await acceptTriggerDelivery(
      db,
      delivery({ definitionVersion: 99 }),
    );
    expect(duplicate).toMatchObject({
      inserted: false,
      stored: {
        definitionVersion: 11,
        result: { result: "started", runId: "run-1" },
      },
    });
    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      subjectKey: "pr:github:acme/api#42",
      ticketKey: null,
      definitionId: 7,
      definitionVersion: 11,
    });
  });

  it("keeps the same delivery id provider-scoped", async () => {
    await acceptTriggerDelivery(db, delivery());
    expect(
      (
        await acceptTriggerDelivery(
          db,
          delivery({
            delivery: { provider: "gitlab", producer: "gitlab-ci", deliveryId: "d-1" },
            pr: { ...delivery().pr, provider: "gitlab" },
          }),
        )
      ).inserted,
    ).toBe(true);
  });

  it("never downgrades a stored started result during a later coalescing retry", async () => {
    await acceptTriggerDelivery(db, delivery());
    await completeTriggerDelivery(db, "github", "d-1", {
      result: "started",
      runId: "run-1",
    });
    await completeTriggerDelivery(db, "github", "d-1", { result: "coalesced" });
    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      result: { result: "started", runId: "run-1" },
    });
  });
});

describe("semantic pending coalescing", () => {
  it("lists each pending subject once in oldest-first recovery order", async () => {
    await coalescePendingTrigger(db, delivery());
    await coalescePendingTrigger(db, {
      ...delivery(),
      delivery: { ...delivery().delivery, deliveryId: "d-2" },
      triggerType: "trigger_pr_review",
    });
    await coalescePendingTrigger(db, delivery({
      delivery: { ...delivery().delivery, deliveryId: "d-3" },
      subjectKey: "pr:github:acme/web#9",
      pr: { ...delivery().pr, repoPath: "acme/web", prNumber: 9 },
    }));

    expect(await listPendingSubjectKeys(db)).toEqual([
      "pr:github:acme/api#42",
      "pr:github:acme/web#9",
    ]);
  });

  it("merges failed checks while preserving the first pinned deployed version", async () => {
    await coalescePendingTrigger(db, delivery());
    await coalescePendingTrigger(
      db,
      delivery({
        delivery: { provider: "github", producer: "github-actions", deliveryId: "d-2" },
        definitionVersion: 12,
        pr: {
          ...delivery().pr,
          failedChecks: [
            { name: "lint", conclusion: "failure" },
            { name: "test", conclusion: "timed_out", detailsUrl: "https://ci/test" },
          ],
        },
      }),
    );

    const pending = await getPendingTrigger(
      db,
      "pr:github:acme/api#42",
      "sha-current",
      "trigger_pr_checks_failed",
    );
    expect(pending?.definitionVersion).toBe(11);
    expect(pending?.pr.failedChecks).toEqual([
      { name: "lint", conclusion: "failure" },
      { name: "test", conclusion: "timed_out", detailsUrl: "https://ci/test" },
    ]);
  });

  it("retains distinct review identities and deduplicates the same review", async () => {
    const first = delivery({
      triggerType: "trigger_pr_review",
      pr: {
        ...delivery().pr,
        failedChecks: undefined,
        review: { state: "changes_requested", author: "alice", body: "Fix A" },
      },
    });
    await coalescePendingTrigger(db, first);
    await coalescePendingTrigger(db, {
      ...first,
      delivery: { ...first.delivery, deliveryId: "d-2" },
    });
    await coalescePendingTrigger(db, {
      ...first,
      delivery: { ...first.delivery, deliveryId: "d-3" },
      pr: {
        ...first.pr,
        review: { state: "commented", author: "bob", body: "Consider B" },
      },
    });

    const pending = await getPendingTrigger(
      db,
      first.subjectKey,
      first.pr.headSha,
      first.triggerType,
    );
    expect(pending?.pr.reviews).toHaveLength(2);
    expect(pending?.pr.reviews).toEqual(
      expect.arrayContaining([
        { state: "changes_requested", author: "alice", body: "Fix A" },
        { state: "commented", author: "bob", body: "Consider B" },
      ]),
    );
  });

  it("deletes only the exact pending delivery snapshot and preserves a concurrent merge", async () => {
    const first = delivery();
    const second = delivery({
      delivery: { provider: "github", producer: "github-actions", deliveryId: "d-2" },
      pr: {
        ...delivery().pr,
        failedChecks: [
          { name: "lint", conclusion: "failure" },
          { name: "test", conclusion: "failure" },
        ],
      },
    });
    await coalescePendingTrigger(db, first);
    const oldSnapshot = await getPendingTrigger(
      db,
      first.subjectKey,
      first.pr.headSha,
      first.triggerType,
    );
    await coalescePendingTrigger(db, second);

    expect(await deletePendingTrigger(db, oldSnapshot!)).toBe(false);
    const current = await getPendingTrigger(
      db,
      first.subjectKey,
      first.pr.headSha,
      first.triggerType,
    );
    expect(current).toMatchObject({
      delivery: { deliveryId: "d-2" },
      pr: { failedChecks: expect.arrayContaining([{ name: "test", conclusion: "failure" }]) },
    });
    expect(await deletePendingTrigger(db, current!)).toBe(true);
  });
});
