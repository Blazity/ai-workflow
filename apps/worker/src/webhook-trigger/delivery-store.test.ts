import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  activeRuns,
  webhookTriggerDeliveries,
  webhookTriggerEndpoints,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  acceptWebhookDelivery,
  coalescePendingWebhookDelivery,
  completeWebhookDelivery,
  drainOldestPendingWebhookDelivery,
  getWebhookDelivery,
  listPendingWebhookDeliveries,
  listRecentWebhookDeliveries,
  recordWebhookDeliveryStarted,
  sweepWebhookDeliveries,
  type AcceptedWebhookDelivery,
} from "./delivery-store.js";

let db: Db;

const ENDPOINT_ID = "wh_test";

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowDefinitions).values({
    id: 9,
    name: "Webhook flow",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values(
    [3, 4].map((version) => ({
      definitionId: 9,
      version,
      definition: {},
      createdById: "test",
      createdByLabel: "Test",
    })),
  );
  await db.insert(webhookTriggerEndpoints).values({
    id: ENDPOINT_ID,
    definitionId: 9,
    nodeId: "entry",
    secretCiphertext: "v1:00000000:iv:tag:data",
  });
});

function delivery(
  deliveryId = "d-1",
  overrides: Partial<AcceptedWebhookDelivery> = {},
): AcceptedWebhookDelivery {
  return {
    endpointId: ENDPOINT_ID,
    deliveryId,
    subjectKey: "webhook:wh_test:T-1",
    definitionId: 9,
    definitionVersion: 3,
    nodeId: "entry",
    entry: {
      subject: "Printer is on fire",
      description: "Smoke everywhere",
      requester: "ops@acme.test",
      priority: "urgent",
      payload: { ticket: { id: "T-1" } },
    },
    verifiedWith: "current",
    ...overrides,
  };
}

async function backdate(deliveryId: string, createdAt: Date): Promise<void> {
  await db
    .update(webhookTriggerDeliveries)
    .set({ createdAt })
    .where(eq(webhookTriggerDeliveries.deliveryId, deliveryId));
}

describe("webhook delivery inbox", () => {
  it("accepts a delivery id exactly once even when two requests race", async () => {
    const [first, second] = await Promise.all([
      acceptWebhookDelivery(db, delivery()),
      acceptWebhookDelivery(
        db,
        delivery("d-1", {
          definitionVersion: 4,
          entry: { ...delivery().entry, subject: "Second writer" },
        }),
      ),
    ]);

    expect([first.inserted, second.inserted].filter(Boolean)).toHaveLength(1);
    for (const accepted of [first, second]) {
      expect(accepted.stored).toMatchObject({
        deliveryId: "d-1",
        definitionVersion: 3,
        pending: false,
        result: null,
        entry: { subject: "Printer is on fire" },
      });
    }
  });

  it("replays a terminal result instead of re-accepting the delivery", async () => {
    await acceptWebhookDelivery(db, delivery());
    await completeWebhookDelivery(db, ENDPOINT_ID, "d-1", {
      outcome: "started",
      reason: null,
      runId: "run-1",
      verifiedWith: "current",
    });

    const replay = await acceptWebhookDelivery(db, delivery());
    expect(replay).toMatchObject({
      inserted: false,
      stored: { pending: false, result: { outcome: "started", runId: "run-1" } },
    });
  });

  it("never lets a weaker outcome overwrite a started run", async () => {
    await acceptWebhookDelivery(db, delivery());
    await completeWebhookDelivery(db, ENDPOINT_ID, "d-1", {
      outcome: "started",
      reason: null,
      runId: "run-1",
      verifiedWith: "current",
    });

    for (const outcome of ["error", "coalesced", "rejected", "test"] as const) {
      await completeWebhookDelivery(db, ENDPOINT_ID, "d-1", {
        outcome,
        reason: "late",
        runId: null,
        verifiedWith: "current",
      });
    }

    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "started", runId: "run-1" },
    });
  });

  it("keeps a failed dispatch pending with its diagnostic", async () => {
    await acceptWebhookDelivery(db, delivery());
    await coalescePendingWebhookDelivery(db, delivery());
    await completeWebhookDelivery(db, ENDPOINT_ID, "d-1", {
      outcome: "error",
      reason: "AIW-DIAG-ingest-stable",
      runId: null,
      verifiedWith: "current",
    });

    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: true,
      result: { outcome: "error", reason: "AIW-DIAG-ingest-stable" },
    });
  });

  it("replaces the pending payload with the newest delivery for the subject", async () => {
    const first = delivery("d-1");
    const second = delivery("d-2", {
      definitionVersion: 4,
      entry: { ...first.entry, subject: "Newest subject", priority: "low" },
    });
    await acceptWebhookDelivery(db, first);
    await acceptWebhookDelivery(db, second);

    await expect(coalescePendingWebhookDelivery(db, first)).resolves.toBe("queued");
    await expect(coalescePendingWebhookDelivery(db, second)).resolves.toBe("coalesced");

    const pending = await listPendingWebhookDeliveries(db, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      deliveryId: "d-1",
      definitionVersion: 4,
      entry: { subject: "Newest subject", priority: "low" },
    });
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-2")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "coalesced" },
    });
  });

  it("re-coalescing the row that already owns the pending slot keeps it queued", async () => {
    await acceptWebhookDelivery(db, delivery());
    await coalescePendingWebhookDelivery(db, delivery());

    await expect(coalescePendingWebhookDelivery(db, delivery())).resolves.toBe("queued");
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: true,
      result: null,
    });
  });

  it("drains the oldest pending delivery, globally and per subject", async () => {
    const older = delivery("d-old", { subjectKey: "webhook:wh_test:T-1" });
    const newer = delivery("d-new", { subjectKey: "webhook:wh_test:T-2" });
    await acceptWebhookDelivery(db, older);
    await coalescePendingWebhookDelivery(db, older);
    await acceptWebhookDelivery(db, newer);
    await coalescePendingWebhookDelivery(db, newer);
    await backdate("d-old", new Date("2026-01-01T00:00:00.000Z"));
    await backdate("d-new", new Date("2026-01-02T00:00:00.000Z"));

    await expect(drainOldestPendingWebhookDelivery(db)).resolves.toMatchObject({
      deliveryId: "d-old",
    });
    await expect(
      drainOldestPendingWebhookDelivery(db, "webhook:wh_test:T-2"),
    ).resolves.toMatchObject({ deliveryId: "d-new" });
    await expect(
      drainOldestPendingWebhookDelivery(db, "webhook:wh_test:T-9"),
    ).resolves.toBeNull();
  });

  it("publishes the start only for the owner that still holds the subject", async () => {
    const accepted = delivery();
    await acceptWebhookDelivery(db, accepted);
    await coalescePendingWebhookDelivery(db, accepted);
    await db.insert(activeRuns).values({
      subjectKey: accepted.subjectKey,
      ticketKey: null,
      ownerToken: "owner-1",
      runId: "run-1",
      state: "bound",
      runKind: "webhook_trigger",
    });

    await expect(
      recordWebhookDeliveryStarted(db, accepted, "other-owner", "run-1"),
    ).resolves.toBe(false);
    await expect(
      recordWebhookDeliveryStarted(db, accepted, "owner-1", "run-1"),
    ).resolves.toBe(true);
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "started", runId: "run-1", verifiedWith: "current" },
    });
  });

  it("keeps the first start and lets the same run republish it", async () => {
    const accepted = delivery();
    await acceptWebhookDelivery(db, accepted);
    await coalescePendingWebhookDelivery(db, accepted);
    await db.insert(activeRuns).values({
      subjectKey: accepted.subjectKey,
      ticketKey: null,
      ownerToken: "owner-1",
      runId: "run-1",
      state: "bound",
      runKind: "webhook_trigger",
    });
    await recordWebhookDeliveryStarted(db, accepted, "owner-1", "run-1");

    // The dispatcher and the run itself both publish the same start.
    await expect(
      recordWebhookDeliveryStarted(db, accepted, "owner-1", "run-1"),
    ).resolves.toBe(true);
    // A later owner of the same subject may not take a delivery that already
    // started: the owner check would pass, the first-start guard must not.
    await db
      .update(activeRuns)
      .set({ ownerToken: "owner-2", runId: "run-2" })
      .where(eq(activeRuns.subjectKey, accepted.subjectKey));
    await expect(
      recordWebhookDeliveryStarted(db, accepted, "owner-2", "run-2"),
    ).resolves.toBe(false);
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "started", runId: "run-1", verifiedWith: "current" },
    });
  });

  it("lists the endpoint log newest first with the secret that authenticated each delivery", async () => {
    const waiting = delivery("d-1");
    await acceptWebhookDelivery(db, waiting);
    await coalescePendingWebhookDelivery(db, waiting);
    await completeWebhookDelivery(db, ENDPOINT_ID, "d-1", {
      outcome: "coalesced",
      reason: "at_capacity",
      runId: null,
      verifiedWith: "current",
    });
    await acceptWebhookDelivery(
      db,
      delivery("d-2", { subjectKey: "webhook:wh_test:T-2", verifiedWith: "previous" }),
    );
    await backdate("d-1", new Date("2026-01-01T00:00:00.000Z"));
    await backdate("d-2", new Date("2026-01-02T00:00:00.000Z"));
    await completeWebhookDelivery(db, ENDPOINT_ID, "d-2", {
      outcome: "rejected",
      reason: "endpoint_revoked",
      runId: null,
      verifiedWith: "previous",
    });

    await expect(listRecentWebhookDeliveries(db, ENDPOINT_ID, 10)).resolves.toEqual([
      {
        deliveryId: "d-2",
        receivedAt: new Date("2026-01-02T00:00:00.000Z"),
        outcome: "rejected",
        reason: "endpoint_revoked",
        runId: null,
        verifiedWith: "previous",
      },
      {
        deliveryId: "d-1",
        receivedAt: new Date("2026-01-01T00:00:00.000Z"),
        // Still waiting for capacity: the log says pending, not the last
        // decision that was written while it waited.
        outcome: "pending",
        reason: "at_capacity",
        runId: null,
        verifiedWith: "current",
      },
    ]);
  });
});

describe("sweepWebhookDeliveries", () => {
  async function settle(deliveryId: string): Promise<void> {
    await acceptWebhookDelivery(db, delivery(deliveryId));
    await completeWebhookDelivery(db, ENDPOINT_ID, deliveryId, {
      outcome: "started",
      reason: null,
      runId: `run-${deliveryId}`,
      verifiedWith: "current",
    });
  }

  it("drops settled deliveries older than the retention window", async () => {
    await settle("d-old");
    await backdate("d-old", new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    await settle("d-recent");

    await sweepWebhookDeliveries(db);

    expect(await getWebhookDelivery(db, ENDPOINT_ID, "d-old")).toBeNull();
    expect(await getWebhookDelivery(db, ENDPOINT_ID, "d-recent")).not.toBeNull();
  });

  it("never deletes a pending delivery, however old", async () => {
    // Accepted, coalesced at capacity, still pending for the drain to start.
    await acceptWebhookDelivery(db, delivery("d-pending"));
    await coalescePendingWebhookDelivery(db, delivery("d-pending"));
    await completeWebhookDelivery(db, ENDPOINT_ID, "d-pending", {
      outcome: "coalesced",
      reason: "at_capacity",
      runId: null,
      verifiedWith: "current",
    });
    await backdate("d-pending", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    await sweepWebhookDeliveries(db);

    const survivor = await getWebhookDelivery(db, ENDPOINT_ID, "d-pending");
    expect(survivor).not.toBeNull();
    expect(survivor!.pending).toBe(true);
  });
});
