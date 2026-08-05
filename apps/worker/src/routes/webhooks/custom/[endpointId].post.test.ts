import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import {
  webhookTriggerDeliveries,
  webhookTriggerEndpoints,
  webhookTriggerRateLimits,
  webhookTriggerRejectionCounters,
  workflowDefinitions,
  workflowDefinitionTriggers,
  workflowDefinitionVersions,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { encryptWebhookSecret } from "../../../lib/webhook-crypto.js";
import { webhookRateWindowStart } from "../../../webhook-trigger/rate-limit.js";
import { mintWebhookEndpointsForDefinition } from "../../../webhook-trigger/endpoint-store.js";
import { rotateWebhookEndpointSecret } from "../../../webhook-trigger/endpoint-store.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const DEFINITION_ID = 9;
const NODE_ID = "entry";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {
    WEBHOOK_TRIGGER_ENCRYPTION_KEY: "a".repeat(64) as string | undefined,
    MAX_CONCURRENT_AGENTS: 3,
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
  },
}));
const mockStart = vi.hoisted(() => vi.fn());

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("workflow/api", () => ({ start: (...args: unknown[]) => mockStart(...args) }));
vi.mock("../../../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));

const route = (await import("./[endpointId].post.js")).default;

let db: Db;
let secret: string;
let endpointId: string;

function handler() {
  const app = createApp();
  const router = createRouter();
  router.post("/webhooks/custom/:endpointId", route);
  app.use(router);
  return toWebHandler(app);
}

function graph(configuration: Record<string, unknown> = { subjectPath: "ticket.id" }) {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: NODE_ID,
        type: "trigger_webhook" as const,
        x: 0,
        y: 0,
        configuration,
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  };
}

const BODY = JSON.stringify({
  ticket: { id: "T-1" },
  subject: "Printer is on fire",
  description: "Smoke everywhere",
  requester: "ops@acme.test",
  priority: "urgent",
});

/** A well-formed id (`wh_` + 24 hex) that names no endpoint. */
const UNKNOWN_ENDPOINT_ID = `wh_${"0".repeat(24)}`;

function signed(
  body = BODY,
  options: { secret?: string; headers?: Record<string, string>; id?: string } = {},
): Request {
  const signingSecret = options.secret ?? secret;
  return new Request(`http://worker.test/webhooks/custom/${options.id ?? endpointId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // An honest sender always declares its length; the route requires it.
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "x-workflow-signature": createHmac("sha256", signingSecret)
        .update(body)
        .digest("hex"),
      ...(options.headers ?? {}),
    },
    body,
  });
}

/** A delivery signed over `${ts}.${body}` with the timestamp in its header, as a
 *  sender does when the endpoint requires replay protection. */
function signedTs(
  options: {
    ts?: number;
    body?: string;
    secret?: string;
    headers?: Record<string, string>;
    id?: string;
  } = {},
): Request {
  const body = options.body ?? BODY;
  const ts = options.ts ?? Math.floor(Date.now() / 1000);
  const signingSecret = options.secret ?? secret;
  return new Request(`http://worker.test/webhooks/custom/${options.id ?? endpointId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "x-workflow-signature": createHmac("sha256", signingSecret)
        .update(`${ts}.${body}`)
        .digest("hex"),
      "x-workflow-timestamp": String(ts),
      ...(options.headers ?? {}),
    },
    body,
  });
}

async function rejections(): Promise<Array<{ reason: string; count: number }>> {
  return db
    .select({
      reason: webhookTriggerRejectionCounters.reason,
      count: webhookTriggerRejectionCounters.count,
    })
    .from(webhookTriggerRejectionCounters);
}

async function delivery(deliveryId: string) {
  const rows = await db
    .select()
    .from(webhookTriggerDeliveries)
    .where(
      and(
        eq(webhookTriggerDeliveries.endpointId, endpointId),
        eq(webhookTriggerDeliveries.deliveryId, deliveryId),
      ),
    );
  return rows[0];
}

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  state.env.WEBHOOK_TRIGGER_ENCRYPTION_KEY = KEY;
  state.env.MAX_CONCURRENT_AGENTS = 3;
  mockStart.mockReset().mockResolvedValue({ runId: "run-1" });

  await db.insert(workflowDefinitions).values({
    id: DEFINITION_ID,
    name: "Webhook flow",
    enabled: true,
    triggerTypes: ["trigger_webhook"],
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: DEFINITION_ID,
    version: 1,
    definition: graph(),
    createdById: "test",
    createdByLabel: "Test",
  });
  await db
    .update(workflowDefinitions)
    .set({ deployedVersion: 1 })
    .where(eq(workflowDefinitions.id, DEFINITION_ID));
  // Deterministic ownership of the trigger: the seeded default definition must
  // never be the one this route resolves.
  await db.delete(workflowDefinitionTriggers);
  await db
    .insert(workflowDefinitionTriggers)
    .values({ triggerType: "trigger_webhook", definitionId: DEFINITION_ID });

  const minted = await mintWebhookEndpointsForDefinition(db, KEY, {
    definitionId: DEFINITION_ID,
    nodes: graph().nodes,
  });
  endpointId = minted[0]!.endpointId;
  secret = minted[0]!.secret!;
});

describe("POST /webhooks/custom/:endpointId", () => {
  it("dispatches a signed delivery and records the mapped entry", async () => {
    const response = await handler()(
      signed(BODY, { headers: { "x-delivery-id": "d-1" } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "dispatched",
      runId: "run-1",
    });
    expect(mockStart.mock.calls[0]?.[1]?.[0]).toMatchObject({
      kind: "webhook_trigger",
      endpointId,
      definitionId: DEFINITION_ID,
      definitionVersion: 1,
      nodeId: NODE_ID,
      deliveryId: "d-1",
      subjectKey: `webhook:${endpointId}:T-1`,
      entry: {
        subject: "Printer is on fire",
        description: "Smoke everywhere",
        requester: "ops@acme.test",
        priority: "urgent",
      },
    });
    expect(await delivery("d-1")).toMatchObject({
      pending: false,
      result: { outcome: "started", runId: "run-1", verifiedWith: "current" },
    });
    expect(await rejections()).toEqual([]);
  });

  it("derives a delivery id from the body when the sender sends none", async () => {
    const response = await handler()(signed());

    expect(response.status).toBe(200);
    const rows = await db.select().from(webhookTriggerDeliveries);
    expect(rows[0]?.deliveryId).toMatch(/^body:[0-9a-f]{64}:\d+$/);
  });

  it("replays the first envelope for a repeated delivery id", async () => {
    await handler()(signed(BODY, { headers: { "x-delivery-id": "d-1" } }));
    const second = await handler()(
      signed(BODY, { headers: { "x-delivery-id": "d-1" } }),
    );

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      status: "dispatched",
      runId: "run-1",
    });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("accepts the replaced secret while a rotation window is open", async () => {
    const rotated = await rotateWebhookEndpointSecret(db, KEY, endpointId);

    const response = await handler()(
      signed(BODY, { secret, headers: { "x-delivery-id": "d-old" } }),
    );

    expect(response.status).toBe(200);
    expect(await delivery("d-old")).toMatchObject({
      result: { outcome: "started", verifiedWith: "previous" },
    });
    // The new secret is the current one, and reports itself as such.
    const fresh = await handler()(
      signed(BODY, { secret: rotated!.secret, headers: { "x-delivery-id": "d-new" } }),
    );
    expect(fresh.status).toBe(200);
    expect(await delivery("d-new")).toMatchObject({
      result: { verifiedWith: "current" },
    });
  });

  it("refuses a malformed endpoint id with 404 and no counter row", async () => {
    // A segment that cannot be a real id must never seed a counter keyed on it.
    const response = await handler()(signed(BODY, { id: "wh_nope" }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ data: { reason: "not_found" } });
    expect(await rejections()).toEqual([]);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("404s a well-formed unknown endpoint and tallies it under one constant id", async () => {
    const response = await handler()(signed(BODY, { id: UNKNOWN_ENDPOINT_ID }));

    expect(response.status).toBe(404);
    // Coarse reason to the caller, precise reason in the operator's counter.
    await expect(response.json()).resolves.toMatchObject({ data: { reason: "not_found" } });
    expect(await rejections()).toEqual([{ reason: "unknown_endpoint", count: 1 }]);
    // Tallied under the constant, not the raw (fake) segment.
    const rows = await db
      .select({ endpointId: webhookTriggerRejectionCounters.endpointId })
      .from(webhookTriggerRejectionCounters);
    expect(rows).toEqual([{ endpointId: "unknown" }]);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("404s a revoked endpoint (collapsed) but tallies endpoint_disabled", async () => {
    await db
      .update(webhookTriggerEndpoints)
      .set({ revokedAt: new Date() })
      .where(eq(webhookTriggerEndpoints.id, endpointId));

    const response = await handler()(signed());

    // Collapsed with unknown so a caller cannot tell "no such endpoint" from
    // "this one was disabled"; the counter keeps the precise reason.
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ data: { reason: "not_found" } });
    expect(await rejections()).toEqual([{ reason: "endpoint_disabled", count: 1 }]);
  });

  it("404s when no enabled definition claims the webhook trigger anymore", async () => {
    await db.delete(workflowDefinitionTriggers);
    await db
      .update(workflowDefinitions)
      .set({ enabled: false })
      .where(eq(workflowDefinitions.id, DEFINITION_ID));

    const response = await handler()(signed());

    expect(response.status).toBe(404);
    expect(await rejections()).toEqual([{ reason: "endpoint_disabled", count: 1 }]);
  });

  it("404s when the live head no longer declares the node", async () => {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: DEFINITION_ID,
      version: 2,
      definition: { schemaVersion: 2, nodes: [], edges: [] },
      createdById: "test",
      createdByLabel: "Test",
    });
    await db
      .update(workflowDefinitions)
      .set({ deployedVersion: 2 })
      .where(eq(workflowDefinitions.id, DEFINITION_ID));

    const response = await handler()(signed());

    expect(response.status).toBe(404);
    expect(await rejections()).toEqual([{ reason: "endpoint_disabled", count: 1 }]);
  });

  it("requires Content-Length and tallies length_required", async () => {
    const response = await handler()(
      new Request(`http://worker.test/webhooks/custom/${endpointId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: BODY,
      }),
    );

    expect(response.status).toBe(411);
    expect(await rejections()).toEqual([{ reason: "length_required", count: 1 }]);
  });

  it("429s a signed delivery once the inbox budget is spent, and tallies it", async () => {
    await db.insert(webhookTriggerRateLimits).values({
      endpointId,
      windowStart: webhookRateWindowStart(),
      kind: "inbox",
      count: 60,
    });

    const response = await handler()(signed());

    expect(response.status).toBe(429);
    expect(await rejections()).toEqual([{ reason: "rate_limited", count: 1 }]);
  });

  it("429s an unsigned flood on the ingress budget, before authentication", async () => {
    await db.insert(webhookTriggerRateLimits).values({
      endpointId,
      windowStart: webhookRateWindowStart(),
      kind: "ingress",
      count: 600,
    });

    // No signature header: an ingress refusal proves the budget is charged
    // before verify, since verification would otherwise answer 401.
    const response = await handler()(
      new Request(`http://worker.test/webhooks/custom/${endpointId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(BODY, "utf8")),
        },
        body: BODY,
      }),
    );

    expect(response.status).toBe(429);
    expect(await rejections()).toEqual([{ reason: "rate_limited", count: 1 }]);
  });

  it("413s a body over the size cap by its declared length and tallies it", async () => {
    const huge = JSON.stringify({ subject: "x".repeat(600 * 1024) });

    const response = await handler()(signed(huge));

    expect(response.status).toBe(413);
    expect(await rejections()).toEqual([{ reason: "payload_too_large", count: 1 }]);
  });

  it("413s on the post-read cap when the declared length lies", async () => {
    const huge = JSON.stringify({ subject: "x".repeat(600 * 1024) });

    // A small declared length slips past the cheap pre-check; the post-read cap
    // is the defense that actually holds. No signature: size is checked first.
    const response = await handler()(
      new Request(`http://worker.test/webhooks/custom/${endpointId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "10" },
        body: huge,
      }),
    );

    expect(response.status).toBe(413);
    expect(await rejections()).toEqual([{ reason: "payload_too_large", count: 1 }]);
  });

  it("503s a secret it cannot decrypt, never 401, and hides the reason from the caller", async () => {
    await db
      .update(webhookTriggerEndpoints)
      .set({ secretCiphertext: encryptWebhookSecret(secret, OTHER_KEY, endpointId) })
      .where(eq(webhookTriggerEndpoints.id, endpointId));

    const response = await handler()(signed());

    expect(response.status).toBe(503);
    // The caller learns only "unavailable"; the precise decrypt_failed stays in
    // the counter so key drift is not an external oracle.
    await expect(response.json()).resolves.toMatchObject({
      data: { reason: "unavailable" },
    });
    expect(await rejections()).toEqual([{ reason: "decrypt_failed", count: 1 }]);
  });

  it("503s with decrypt_failed in the counter when the encryption key is not configured", async () => {
    state.env.WEBHOOK_TRIGGER_ENCRYPTION_KEY = undefined;

    const response = await handler()(signed());

    expect(response.status).toBe(503);
    expect(await rejections()).toEqual([{ reason: "decrypt_failed", count: 1 }]);
  });

  it("401s a delivery with no signature header, collapsing the reason", async () => {
    const response = await handler()(
      new Request(`http://worker.test/webhooks/custom/${endpointId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(BODY, "utf8")),
        },
        body: BODY,
      }),
    );

    expect(response.status).toBe(401);
    // "no signature" and "wrong signature" both answer unauthorized to the caller.
    await expect(response.json()).resolves.toMatchObject({ data: { reason: "unauthorized" } });
    expect(await rejections()).toEqual([{ reason: "missing_signature", count: 1 }]);
  });

  it("401s a delivery signed with the wrong secret and tallies the precise reason", async () => {
    const response = await handler()(signed(BODY, { secret: "whsec_wrong" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ data: { reason: "unauthorized" } });
    expect(await rejections()).toEqual([{ reason: "invalid_signature", count: 1 }]);
  });

  it("422s an authenticated body that is not JSON and tallies it", async () => {
    const response = await handler()(signed("not json at all"));

    expect(response.status).toBe(422);
    expect(await rejections()).toEqual([{ reason: "invalid_payload", count: 1 }]);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("503s and keeps the delivery pending when there is no capacity", async () => {
    state.env.MAX_CONCURRENT_AGENTS = 0;

    const response = await handler()(
      signed(BODY, { headers: { "x-delivery-id": "d-1" } }),
    );

    expect(response.status).toBe(503);
    expect(await delivery("d-1")).toMatchObject({ pending: true });
    // A dispatch outcome is not a rejection: it is durably recorded instead.
    expect(await rejections()).toEqual([]);
  });

  it("500s with a diagnostic id when the start fails", async () => {
    mockStart.mockRejectedValueOnce(new Error("workflow runtime unavailable"));

    const response = await handler()(
      signed(BODY, { headers: { "x-delivery-id": "d-1" } }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.data.diagnosticId).toEqual(expect.any(String));
    expect(await delivery("d-1")).toMatchObject({
      pending: true,
      result: { outcome: "error" },
    });
  });

  it("returns 200 {status:'coalesced'} for a second delivery on a busy subject", async () => {
    await handler()(signed(BODY, { headers: { "x-delivery-id": "d-1" } }));

    const response = await handler()(
      signed(BODY, { headers: { "x-delivery-id": "d-2" } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "coalesced" });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("returns 200 {status:'rejected'} when replaying a stored rejected result", async () => {
    // A delivery that was already decided as rejected (its endpoint went away
    // between acceptance and dispatch). A resend replays that verdict.
    await db.insert(webhookTriggerDeliveries).values({
      endpointId,
      deliveryId: "d-rej",
      subjectKey: `webhook:${endpointId}:T-1`,
      definitionId: DEFINITION_ID,
      definitionVersion: 1,
      payload: {
        endpointId,
        deliveryId: "d-rej",
        subjectKey: `webhook:${endpointId}:T-1`,
        definitionId: DEFINITION_ID,
        definitionVersion: 1,
        nodeId: NODE_ID,
        entry: { subject: "", description: "", requester: "", priority: "", payload: {} },
        verifiedWith: null,
      },
      pending: false,
      result: {
        outcome: "rejected",
        reason: "endpoint_revoked",
        runId: null,
        verifiedWith: null,
      },
    });

    const response = await handler()(
      signed(BODY, { headers: { "x-delivery-id": "d-rej" } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "rejected",
      reason: "endpoint_revoked",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("authenticates an end-to-end shared_token delivery on a custom header", async () => {
    // A deploy synced this endpoint to the shared-token scheme with an operator's
    // header override; the delivery presents the raw secret in that header.
    await db
      .update(webhookTriggerEndpoints)
      .set({ authScheme: "shared_token", headerName: "X-My-Token" })
      .where(eq(webhookTriggerEndpoints.id, endpointId));

    const response = await handler()(
      new Request(`http://worker.test/webhooks/custom/${endpointId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(BODY, "utf8")),
          "x-my-token": secret,
          "x-delivery-id": "d-tok",
        },
        body: BODY,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "dispatched",
      runId: "run-1",
    });
    expect(await delivery("d-tok")).toMatchObject({
      result: { outcome: "started", verifiedWith: "current" },
    });
    expect(await rejections()).toEqual([]);
  });

  async function enableReplayProtection() {
    await db
      .update(webhookTriggerEndpoints)
      .set({ requireTimestamp: true })
      .where(eq(webhookTriggerEndpoints.id, endpointId));
  }

  it("dispatches a fresh timestamped delivery when replay protection is on", async () => {
    await enableReplayProtection();

    const response = await handler()(signedTs({ headers: { "x-delivery-id": "d-ts" } }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "dispatched",
      runId: "run-1",
    });
    expect(await delivery("d-ts")).toMatchObject({
      result: { outcome: "started", verifiedWith: "current" },
    });
    expect(await rejections()).toEqual([]);
  });

  it("401s a stale timestamped delivery, precise stale_timestamp in the counter", async () => {
    await enableReplayProtection();

    const stale = Math.floor(Date.now() / 1000) - 4000;
    const response = await handler()(signedTs({ ts: stale }));

    expect(response.status).toBe(401);
    // Coarse unauthorized to the caller; precise reason for the operator.
    await expect(response.json()).resolves.toMatchObject({ data: { reason: "unauthorized" } });
    expect(await rejections()).toEqual([{ reason: "stale_timestamp", count: 1 }]);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("401s a replay-required delivery that carries no timestamp header", async () => {
    await enableReplayProtection();

    // A perfectly signed body, but no timestamp: the freshness gate refuses it
    // before any secret is tried.
    const response = await handler()(signed());

    expect(response.status).toBe(401);
    expect(await rejections()).toEqual([{ reason: "stale_timestamp", count: 1 }]);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("ignores a timestamp header entirely when replay protection is off", async () => {
    // Flag off by default: a body-only signature still dispatches even with a
    // junk timestamp header present, proving the off path is byte-identical.
    const response = await handler()(
      signed(BODY, {
        headers: { "x-delivery-id": "d-off", "x-workflow-timestamp": "not-a-number" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "dispatched",
      runId: "run-1",
    });
    expect(await rejections()).toEqual([]);
  });

  it("keeps the timestamp out of the dedup key: two fresh deliveries, same body, one run", async () => {
    await enableReplayProtection();

    const now = Math.floor(Date.now() / 1000);
    // Two valid deliveries of the same body with different fresh timestamps and
    // no delivery id: the fallback id hashes the body only, so they coalesce.
    const first = await handler()(signedTs({ ts: now }));
    const second = await handler()(signedTs({ ts: now - 10 }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockStart).toHaveBeenCalledOnce();
    expect(await db.select().from(webhookTriggerDeliveries)).toHaveLength(1);
  });
});
