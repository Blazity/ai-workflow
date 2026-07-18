import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  activeRuns,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import type { AcceptedTriggerDelivery } from "./trigger-delivery-store.js";
import {
  acceptTriggerDelivery,
  acknowledgeStartedTriggerDelivery,
  completeTriggerDelivery,
  coalescePendingTrigger,
  deletePendingTrigger,
  getPendingTrigger,
  getTriggerDelivery,
  listRecoverableAcceptedTriggerDeliveries,
  listPendingTriggersForSubject,
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

async function bindRun(
  accepted: AcceptedTriggerDelivery,
  runId: string,
): Promise<void> {
  await db.insert(activeRuns).values({
    subjectKey: accepted.subjectKey,
    ticketKey: accepted.ticketKey,
    ownerToken: `owner:${runId}`,
    runId,
    state: "bound",
    runKind: "pr_trigger",
  });
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

  it("preserves a live candidate from loser writes but advances a recovered candidate", async () => {
    await acceptTriggerDelivery(db, delivery());
    await completeTriggerDelivery(db, "github", "d-1", {
      result: "candidate_started",
      runId: "run-crashed",
    });
    await completeTriggerDelivery(db, "github", "d-1", { result: "coalesced" });
    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      result: { result: "candidate_started", runId: "run-crashed" },
    });

    await completeTriggerDelivery(db, "github", "d-1", {
      result: "candidate_started",
      runId: "run-recovered",
    });
    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      result: { result: "candidate_started", runId: "run-recovered" },
    });
  });

  it("lets freshness validation retire a dead candidate as stale", async () => {
    await acceptTriggerDelivery(db, delivery());
    await completeTriggerDelivery(db, "github", "d-1", {
      result: "candidate_started",
      runId: "run-crashed",
    });

    await completeTriggerDelivery(db, "github", "d-1", {
      result: "ignored_stale_head",
    });

    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      result: { result: "ignored_stale_head" },
    });
  });

  it("lists only unfinished accepted deliveries at or before the recovery cutoff", async () => {
    const unfinished = delivery();
    const completed = delivery({
      delivery: { ...delivery().delivery, deliveryId: "d-completed" },
    });
    await acceptTriggerDelivery(db, unfinished);
    await acceptTriggerDelivery(db, completed);
    await completeTriggerDelivery(db, "github", "d-completed", {
      result: "candidate_started",
      runId: "run-live",
    });

    await expect(
      listRecoverableAcceptedTriggerDeliveries(db, new Date(0)),
    ).resolves.toEqual([]);

    await expect(
      listRecoverableAcceptedTriggerDeliveries(
        db,
        new Date(Date.now() + 60_000),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        delivery: expect.objectContaining({ deliveryId: "d-1" }),
        definitionId: 7,
        definitionVersion: 11,
        status: "accepted",
        result: null,
      }),
    ]);
  });

  it("atomically records the winning run through the production execute-only surface", async () => {
    const accepted = delivery();
    await acceptTriggerDelivery(db, accepted);
    await coalescePendingTrigger(db, accepted);
    await bindRun(accepted, "run-winning");

    // neon-http supports one data-modifying statement here, not an interactive
    // transaction callback. Keep this facade limited to that production-safe
    // surface while executing against the real test database.
    const executeOnlyDb: Pick<Db, "execute"> = { execute: db.execute.bind(db) };

    await expect(
      acknowledgeStartedTriggerDelivery(executeOnlyDb, accepted, "run-winning"),
    ).resolves.toBe(true);

    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      status: "completed",
      result: { result: "started", runId: "run-winning" },
    });
    expect(
      await getPendingTrigger(
        db,
        accepted.subjectKey,
        accepted.pr.headSha,
        accepted.triggerType,
      ),
    ).toBeNull();
  });

  it("does not let a workflow that lost the subject claim acknowledge the delivery", async () => {
    const accepted = delivery();
    await acceptTriggerDelivery(db, accepted);
    await coalescePendingTrigger(db, accepted);
    await bindRun(accepted, "run-winning");

    await expect(
      acknowledgeStartedTriggerDelivery(db, accepted, "run-losing"),
    ).resolves.toBe(false);

    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      status: "accepted",
      result: null,
    });
    expect(
      await getPendingTrigger(
        db,
        accepted.subjectKey,
        accepted.pr.headSha,
        accepted.triggerType,
      ),
    ).toMatchObject({ delivery: { deliveryId: "d-1" } });
  });

  it("preserves a newer pending snapshot while acknowledging the claimed delivery", async () => {
    const accepted = delivery();
    const newer = delivery({
      delivery: { ...accepted.delivery, deliveryId: "d-2" },
      pr: {
        ...accepted.pr,
        failedChecks: [
          ...(accepted.pr.failedChecks ?? []),
          { name: "test", conclusion: "failure" },
        ],
      },
    });
    await acceptTriggerDelivery(db, accepted);
    await acceptTriggerDelivery(db, newer);
    await coalescePendingTrigger(db, accepted);
    await coalescePendingTrigger(db, newer);
    await bindRun(accepted, "run-winning");

    await acknowledgeStartedTriggerDelivery(db, accepted, "run-winning");

    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      status: "completed",
      result: { result: "started", runId: "run-winning" },
    });
    expect(
      await getPendingTrigger(
        db,
        accepted.subjectKey,
        accepted.pr.headSha,
        accepted.triggerType,
      ),
    ).toMatchObject({ delivery: { deliveryId: "d-2" } });
  });

  it("does not consume a recovered snapshot after another run already won the delivery", async () => {
    const accepted = delivery();
    await acceptTriggerDelivery(db, accepted);
    await bindRun(accepted, "run-original");
    await acknowledgeStartedTriggerDelivery(db, accepted, "run-original");

    // Recovery can recreate the semantic snapshot after the original workflow
    // has recorded its result. A successor claim must not adopt that delivery.
    await coalescePendingTrigger(db, accepted);
    await db.delete(activeRuns);
    await bindRun(accepted, "run-successor");

    await acknowledgeStartedTriggerDelivery(db, accepted, "run-successor");

    expect(await getTriggerDelivery(db, "github", "d-1")).toMatchObject({
      status: "completed",
      result: { result: "started", runId: "run-original" },
    });
    expect(
      await getPendingTrigger(
        db,
        accepted.subjectKey,
        accepted.pr.headSha,
        accepted.triggerType,
      ),
    ).toMatchObject({ delivery: { deliveryId: "d-1" } });
  });
});

describe("semantic pending coalescing", () => {
  it("keeps pending events isolated by immutable workflow version", async () => {
    const version11 = delivery();
    const version12 = delivery({
      delivery: { provider: "github", producer: "github-actions", deliveryId: "d-2" },
      definitionVersion: 12,
      pr: {
        ...delivery().pr,
        failedChecks: [{ name: "test", conclusion: "failure" }],
      },
    });

    await coalescePendingTrigger(db, version11);
    await coalescePendingTrigger(db, version12);

    const pending = await listPendingTriggersForSubject(db, version11.subjectKey);
    expect(pending).toHaveLength(2);
    expect(pending.map((entry) => entry.definitionVersion)).toEqual([11, 12]);
    expect(pending[0]?.pr.failedChecks).toEqual([{ name: "lint", conclusion: "failure" }]);
    expect(pending[1]?.pr.failedChecks).toEqual([{ name: "test", conclusion: "failure" }]);
  });

  it("uses the newest GitLab pipeline as the representative same-version payload", async () => {
    const pipeline901 = delivery({
      delivery: {
        provider: "gitlab",
        producer: "gitlab-ci",
        deliveryId: "pipeline-901",
        source: "merge_request_event",
      },
      pr: {
        ...delivery().pr,
        provider: "gitlab",
        pipelineId: 901,
      },
    });
    const pipeline902 = delivery({
      ...pipeline901,
      delivery: { ...pipeline901.delivery, deliveryId: "pipeline-902" },
      pr: {
        ...pipeline901.pr,
        pipelineId: 902,
        failedChecks: [{ name: "test", conclusion: "failed" }],
      },
    });

    await coalescePendingTrigger(db, pipeline901);
    await coalescePendingTrigger(db, pipeline902);

    await expect(
      getPendingTrigger(
        db,
        pipeline901.subjectKey,
        pipeline901.pr.headSha,
        pipeline901.triggerType,
      ),
    ).resolves.toMatchObject({
      delivery: { deliveryId: "pipeline-902" },
      pr: {
        pipelineId: 902,
        failedChecks: [{ name: "test", conclusion: "failed" }],
      },
    });
  });

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

  it("merges failed checks within the same pinned deployed version", async () => {
    await coalescePendingTrigger(db, delivery());
    await coalescePendingTrigger(
      db,
      delivery({
        delivery: { provider: "github", producer: "github-actions", deliveryId: "d-2" },
        definitionVersion: 11,
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

  it("keeps provider, delivery, producer, and payload coherent when providers coalesce", async () => {
    const github = delivery({
      scope: "workflow_owned",
      subjectKey: "ticket:jira:AIW-1",
      ticketKey: "AIW-1",
    });
    const gitlab = delivery({
      delivery: { provider: "gitlab", producer: "gitlab-ci", deliveryId: "gl-2" },
      scope: "any",
      subjectKey: github.subjectKey,
      ticketKey: github.ticketKey,
      definitionVersion: github.definitionVersion,
      pr: {
        ...github.pr,
        provider: "gitlab",
        repoPath: "acme/gitlab-api",
        prUrl: "https://gitlab.com/acme/gitlab-api/-/merge_requests/42",
      },
    });

    await coalescePendingTrigger(db, github);
    await coalescePendingTrigger(db, gitlab);

    const pending = await getPendingTrigger(
      db,
      github.subjectKey,
      github.pr.headSha,
      github.triggerType,
    );
    expect(pending).toMatchObject({
      scope: github.scope,
      delivery: gitlab.delivery,
      pr: {
        provider: "gitlab",
        repoPath: "acme/gitlab-api",
      },
      definitionId: github.definitionId,
      definitionVersion: github.definitionVersion,
    });
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
