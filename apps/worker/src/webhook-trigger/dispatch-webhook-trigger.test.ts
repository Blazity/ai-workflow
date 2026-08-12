import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  triggerRateLimits,
  triggerRejectionCounters,
  webhookTriggerDeliveries,
  webhookTriggerEndpoints,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import { getWebhookDelivery } from "./delivery-store.js";

vi.mock("../../env.js", () => ({
  env: { JIRA_PROJECT_KEY: "PROJ", COLUMN_AI: "AI" },
}));
const mockStart = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
// The definition store is only reachable from ticket dispatch in this module's
// import graph; stubbing it keeps this test independent of that file.
vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: vi.fn(async () => null),
}));
const dbRef = vi.hoisted(() => ({ current: null as unknown as Db }));
vi.mock("../db/client.js", () => ({ getDb: () => dbRef.current }));

const {
  dispatchWebhookDelivery,
  fallbackWebhookDeliveryId,
  redispatchPendingWebhookDeliveries,
} = await import("./dispatch-webhook-trigger.js");
type DispatchParams = Parameters<typeof dispatchWebhookDelivery>[0];
type DispatchDeps = Parameters<typeof dispatchWebhookDelivery>[1];

const ENDPOINT_ID = "wh_test";
let db: Db;
let registry: PostgresRunRegistry;

beforeEach(async () => {
  db = await createTestDb();
  dbRef.current = db;
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
  registry = new PostgresRunRegistry(db);
  mockStart.mockReset().mockResolvedValue({ runId: "run-1" });
});

function params(overrides: Partial<DispatchParams> = {}): DispatchParams {
  return {
    endpointId: ENDPOINT_ID,
    deliveryId: "d-1",
    definitionId: 9,
    definitionVersion: 3,
    nodeId: "entry",
    subjectId: "T-1",
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

function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    db,
    runRegistry: registry,
    maxConcurrentAgents: 3,
    ensureStillDispatchable: vi.fn(async () => null),
    // Unlimited by default, so the rest of the suite is unaffected.
    resolveTriggerRateLimit: vi.fn(async () => null),
    ...overrides,
  };
}

describe("webhook delivery dispatch", () => {
  it("starts one run and hands the workflow the frozen webhook entry", async () => {
    await expect(dispatchWebhookDelivery(params(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-1",
    });

    expect(mockStart).toHaveBeenCalledOnce();
    expect(mockStart.mock.calls[0]?.[1]?.[0]).toMatchObject({
      kind: "webhook_trigger",
      endpointId: ENDPOINT_ID,
      definitionId: 9,
      definitionVersion: 3,
      nodeId: "entry",
      deliveryId: "d-1",
      subjectKey: "webhook:wh_test:T-1",
      entry: { subject: "Printer is on fire", payload: { ticket: { id: "T-1" } } },
      ownerToken: expect.stringMatching(/^owner:/),
    });
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "started", runId: "run-1", verifiedWith: "current" },
    });
    await expect(registry.get("webhook:wh_test:T-1")).resolves.toMatchObject({
      runId: "run-1",
      state: "bound",
      kind: "webhook_trigger",
    });
  });

  it("falls back to the delivery id as the subject when no subject id resolves", async () => {
    await dispatchWebhookDelivery(params({ subjectId: null }), deps());

    expect(mockStart.mock.calls[0]?.[1]?.[0]).toMatchObject({
      subjectKey: "webhook:wh_test:d-1",
    });
  });

  it("replays the stored result for a resend instead of starting a second run", async () => {
    await dispatchWebhookDelivery(params(), deps());

    await expect(dispatchWebhookDelivery(params(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-1",
    });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("keeps a delivery pending when the system is at capacity", async () => {
    await expect(
      dispatchWebhookDelivery(params(), deps({ maxConcurrentAgents: 0 })),
    ).resolves.toEqual({ result: "at_capacity" });

    expect(mockStart).not.toHaveBeenCalled();
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: true,
      result: { outcome: "coalesced", reason: "at_capacity" },
    });
  });

  it("coalesces a newer delivery into the waiting one and drains the newest payload", async () => {
    await dispatchWebhookDelivery(params(), deps({ maxConcurrentAgents: 0 }));

    await expect(
      dispatchWebhookDelivery(
        params({
          deliveryId: "d-2",
          definitionVersion: 4,
          entry: { ...params().entry, subject: "Newest subject" },
        }),
        deps({ maxConcurrentAgents: 0 }),
      ),
    ).resolves.toEqual({ result: "coalesced" });
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-2")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "coalesced" },
    });

    await expect(redispatchPendingWebhookDeliveries(deps())).resolves.toEqual([
      { result: "started", runId: "run-1" },
    ]);
    expect(mockStart.mock.calls[0]?.[1]?.[0]).toMatchObject({
      deliveryId: "d-1",
      definitionId: 9,
      definitionVersion: 4,
      entry: { subject: "Newest subject" },
    });
    // A re-dispatch must not fold row bookkeeping back into the payload column.
    const [row] = await db
      .select({ payload: webhookTriggerDeliveries.payload })
      .from(webhookTriggerDeliveries)
      .where(eq(webhookTriggerDeliveries.deliveryId, "d-1"));
    expect(Object.keys(row?.payload as Record<string, unknown>).sort()).toEqual([
      "definitionId",
      "definitionVersion",
      "deliveryId",
      "endpointId",
      "entry",
      "nodeId",
      "subjectKey",
      "verifiedWith",
    ]);
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "started", runId: "run-1" },
    });
  });

  it("coalesces a delivery that arrives while its subject already has a run", async () => {
    await dispatchWebhookDelivery(params(), deps());

    await expect(
      dispatchWebhookDelivery(params({ deliveryId: "d-2" }), deps()),
    ).resolves.toEqual({ result: "coalesced" });
    expect(mockStart).toHaveBeenCalledOnce();
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-2")).resolves.toMatchObject({
      pending: true,
      result: { outcome: "coalesced", reason: "already_claimed" },
    });
  });

  it("refuses a delivery whose endpoint or node disappeared after it was authenticated", async () => {
    const ensureStillDispatchable = vi.fn(async () => "endpoint_revoked" as const);

    await expect(
      dispatchWebhookDelivery(params(), deps({ ensureStillDispatchable })),
    ).resolves.toEqual({ result: "rejected", reason: "endpoint_revoked" });

    expect(ensureStillDispatchable).toHaveBeenCalledWith({
      endpointId: ENDPOINT_ID,
      definitionId: 9,
      definitionVersion: 3,
      nodeId: "entry",
    });
    expect(mockStart).not.toHaveBeenCalled();
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "rejected", reason: "endpoint_revoked" },
    });
    // The reservation is released, so a repaired endpoint is not blocked.
    await expect(registry.get("webhook:wh_test:T-1")).resolves.toBeNull();
  });

  it("keeps a start failure pending with a diagnostic for the drain", async () => {
    mockStart.mockRejectedValueOnce(new Error("workflow runtime unavailable"));

    const failed = await dispatchWebhookDelivery(params(), deps());
    expect(failed).toMatchObject({ result: "error" });
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-1")).resolves.toMatchObject({
      pending: true,
      result: { outcome: "error" },
    });

    mockStart.mockResolvedValue({ runId: "run-2" });
    await expect(redispatchPendingWebhookDeliveries(deps())).resolves.toEqual([
      { result: "started", runId: "run-2" },
    ]);
  });

  it("derives a stable fallback delivery id from the body and its six-hour bucket", () => {
    const body = '{"subject":"no delivery id header"}';
    const first = fallbackWebhookDeliveryId(body, new Date("2026-04-01T01:00:00.000Z"));

    expect(first).toBe(
      fallbackWebhookDeliveryId(body, new Date("2026-04-01T05:59:59.000Z")),
    );
    expect(first).not.toBe(
      fallbackWebhookDeliveryId(body, new Date("2026-04-01T06:00:00.000Z")),
    );
    expect(first).not.toBe(
      fallbackWebhookDeliveryId('{"subject":"other"}', new Date("2026-04-01T01:00:00.000Z")),
    );
    expect(first).toMatch(/^body:[0-9a-f]{64}:\d+$/);
  });
});

describe("webhook trigger rate limit", () => {
  const perMinute = { max: 1, windowKind: "minute" as const };

  it("rejects the delivery terminally once the node limit is spent and tallies it", async () => {
    const resolveTriggerRateLimit = vi.fn(async () => perMinute);

    await expect(
      dispatchWebhookDelivery(params(), deps({ resolveTriggerRateLimit })),
    ).resolves.toEqual({ result: "started", runId: "run-1" });

    // A different subject, so the second delivery reaches the limit instead of
    // stopping at the busy-subject guard.
    await expect(
      dispatchWebhookDelivery(
        params({ deliveryId: "d-2", subjectId: "T-2" }),
        deps({ resolveTriggerRateLimit }),
      ),
    ).resolves.toEqual({ result: "rejected", reason: "rate_limited" });

    expect(mockStart).toHaveBeenCalledOnce();
    // Terminal, and specifically not pending: the drain must never retry a
    // delivery the limit refused, because the limit drops excess starts rather
    // than deferring them.
    await expect(getWebhookDelivery(db, ENDPOINT_ID, "d-2")).resolves.toMatchObject({
      pending: false,
      result: { outcome: "rejected", reason: "rate_limited", runId: null },
    });
    // No run row for the refused delivery: the subject is free again.
    await expect(registry.get("webhook:wh_test:T-2")).resolves.toBeNull();

    await expect(
      db.select().from(triggerRejectionCounters),
    ).resolves.toMatchObject([
      { definitionId: "9", nodeId: "entry", reason: "rate_limited", count: 1 },
    ]);
  });

  it("counts the refused start too, so a flood stays refused for the window", async () => {
    const resolveTriggerRateLimit = vi.fn(async () => perMinute);

    for (const index of [1, 2, 3, 4]) {
      await dispatchWebhookDelivery(
        params({ deliveryId: `d-${index}`, subjectId: `T-${index}` }),
        deps({ resolveTriggerRateLimit }),
      );
    }

    expect(mockStart).toHaveBeenCalledOnce();
    const [counter] = await db.select().from(triggerRateLimits);
    expect(counter).toMatchObject({ definitionId: "9", nodeId: "entry", count: 4 });
    const [rejections] = await db.select().from(triggerRejectionCounters);
    expect(rejections).toMatchObject({ reason: "rate_limited", count: 3 });
  });

  it("never spends the limit on a replayed delivery", async () => {
    const resolveTriggerRateLimit = vi.fn(async () => perMinute);

    await dispatchWebhookDelivery(params(), deps({ resolveTriggerRateLimit }));
    // The same delivery id again: the stored result answers it, and nothing is
    // counted a second time.
    await expect(
      dispatchWebhookDelivery(params(), deps({ resolveTriggerRateLimit })),
    ).resolves.toEqual({ result: "started", runId: "run-1" });

    expect(resolveTriggerRateLimit).toHaveBeenCalledOnce();
    const [counter] = await db.select().from(triggerRateLimits);
    expect(counter).toMatchObject({ count: 1 });
  });

  it("does not spend the limit on a delivery that loses its subject", async () => {
    const resolveTriggerRateLimit = vi.fn(async () => perMinute);
    await dispatchWebhookDelivery(params(), deps({ resolveTriggerRateLimit }));

    // Same subject while the first run holds it: coalesced before the limit.
    await expect(
      dispatchWebhookDelivery(
        params({ deliveryId: "d-2" }),
        deps({ resolveTriggerRateLimit }),
      ),
    ).resolves.toEqual({ result: "coalesced" });

    expect(resolveTriggerRateLimit).toHaveBeenCalledOnce();
    const [counter] = await db.select().from(triggerRateLimits);
    expect(counter).toMatchObject({ count: 1 });
  });

  it("writes no counter row at all for an unlimited node", async () => {
    await dispatchWebhookDelivery(params(), deps());

    await expect(db.select().from(triggerRateLimits)).resolves.toEqual([]);
    await expect(db.select().from(triggerRejectionCounters)).resolves.toEqual([]);
  });
});
