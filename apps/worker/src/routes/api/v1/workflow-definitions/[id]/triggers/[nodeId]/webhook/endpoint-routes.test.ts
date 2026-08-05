import { eq } from "drizzle-orm";
import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../../../../../../db/client.js";
import {
  activeRuns,
  member,
  organization,
  user,
  webhookTriggerDeliveries,
  webhookTriggerEndpoints,
  webhookTriggerRejectionCounters,
  workflowDefinitions,
  workflowDefinitionTriggers,
  workflowDefinitionVersions,
} from "../../../../../../../../db/schema.js";
import { createTestDb } from "../../../../../../../../db/test-db.js";
import {
  acceptWebhookDelivery,
  completeWebhookDelivery,
} from "../../../../../../../../webhook-trigger/delivery-store.js";
import { fallbackWebhookDeliveryId } from "../../../../../../../../webhook-trigger/dispatch-webhook-trigger.js";
import {
  getWebhookEndpointForNode,
  mintWebhookEndpointsForDefinition,
  revokeWebhookEndpoint,
} from "../../../../../../../../webhook-trigger/endpoint-store.js";
import { webhookRejectionWindowStart } from "../../../../../../../../webhook-trigger/rejection-counters.js";

const KEY = "a".repeat(64);
const DEFINITION_ID = 9;
const NODE_ID = "entry";
const BASE = `/api/v1/workflow-definitions/${DEFINITION_ID}/triggers/${NODE_ID}/webhook`;

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: {
    WEBHOOK_TRIGGER_ENCRYPTION_KEY: "a".repeat(64) as string | undefined,
    DASHBOARD_ORG_SLUG: "ai-workflow",
    MAX_CONCURRENT_AGENTS: 3,
  },
}));
const mockStart = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../../../../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../../../../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));
vi.mock("workflow/api", () => ({ start: (...args: unknown[]) => mockStart(...args) }));

const configGet = (await import("./config.get.js")).default;
const rotatePost = (await import("./rotate.post.js")).default;
const revealPost = (await import("./reveal.post.js")).default;
const revokePost = (await import("./revoke.post.js")).default;
const unrevokePost = (await import("./unrevoke.post.js")).default;
const deliveriesGet = (await import("./deliveries.get.js")).default;
const testDeliveryPost = (await import("./test-delivery.post.js")).default;
const { MASKED_WEBHOOK_SECRET } = await import("./endpoint-route.js");

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(route: any, method: "GET" | "POST", suffix: string, body?: unknown) {
  const app = createApp();
  const router = createRouter();
  const pattern =
    "/api/v1/workflow-definitions/:id/triggers/:nodeId/webhook" + suffix;
  if (method === "GET") router.get(pattern, route);
  else router.post(pattern, route);
  app.use(router);
  return toWebHandler(app)(
    new Request(`http://worker.test${BASE}${suffix}`, {
      method,
      // The endpoint URL is derived from the host this request arrived on, which
      // is a header rather than part of the Request's own URL.
      headers: {
        host: "worker.test",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
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

async function deployWebhookDefinition(): Promise<void> {
  await db.insert(workflowDefinitionVersions).values({
    definitionId: DEFINITION_ID,
    version: 1,
    definition: graph(),
    createdById: "test",
    createdByLabel: "Test",
  });
  await db
    .update(workflowDefinitions)
    .set({ deployedVersion: 1, enabled: true })
    .where(eq(workflowDefinitions.id, DEFINITION_ID));
}

async function mintEndpoint(): Promise<{ endpointId: string; secret: string }> {
  const minted = await mintWebhookEndpointsForDefinition(db, KEY, {
    definitionId: DEFINITION_ID,
    nodes: graph().nodes,
  });
  return { endpointId: minted[0]!.endpointId, secret: minted[0]!.secret! };
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;
  state.sessionUserId = "user_admin";
  state.env.WEBHOOK_TRIGGER_ENCRYPTION_KEY = KEY;

  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "m_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "m_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
  await db.insert(workflowDefinitions).values({
    id: DEFINITION_ID,
    name: "Webhook flow",
    enabled: true,
    triggerTypes: ["trigger_webhook"],
    createdById: "test",
    createdByLabel: "Test",
  });
});

describe("GET .../webhook/config", () => {
  it("reports the feature as unconfigured without an encryption key", async () => {
    state.env.WEBHOOK_TRIGGER_ENCRYPTION_KEY = undefined;

    const response = await call(configGet, "GET", "/config");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "unconfigured",
      endpoint: null,
    });
  });

  it("reports a node that is not deployed yet, without minting", async () => {
    const response = await call(configGet, "GET", "/config");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "await_deploy",
      endpoint: null,
    });
    expect(await db.select().from(webhookTriggerEndpoints)).toEqual([]);
  });

  it("mints the missing endpoint of a deployed, enabled definition on read", async () => {
    await deployWebhookDefinition();

    const response = await call(configGet, "GET", "/config");

    expect(response.status).toBe(200);
    const body = await response.json();
    const stored = await getWebhookEndpointForNode(db, DEFINITION_ID, NODE_ID);
    expect(stored).not.toBeNull();
    expect(body).toEqual({
      state: "active",
      endpoint: {
        endpointId: stored!.id,
        url: `http://worker.test/webhooks/custom/${stored!.id}`,
        authScheme: "hmac_sha256",
        headerName: "X-Workflow-Signature",
        maskedSecret: MASKED_WEBHOOK_SECRET,
        hasPendingRotation: false,
        previousExpiresAt: null,
        rejectionsToday: [],
      },
    });
    // The mask reveals nothing that could be checked against the real secret.
    expect(body.endpoint.maskedSecret).not.toContain(stored!.secretCiphertext.slice(0, 8));
  });

  it("does not mint for a disabled definition", async () => {
    await deployWebhookDefinition();
    await db
      .update(workflowDefinitions)
      .set({ enabled: false })
      .where(eq(workflowDefinitions.id, DEFINITION_ID));

    await expect((await call(configGet, "GET", "/config")).json()).resolves.toEqual({
      state: "await_deploy",
      endpoint: null,
    });
    expect(await db.select().from(webhookTriggerEndpoints)).toEqual([]);
  });

  it("reports a revoked endpoint with its configuration and today's refusals", async () => {
    await deployWebhookDefinition();
    const { endpointId } = await mintEndpoint();
    await revokeWebhookEndpoint(db, endpointId);
    await db.insert(webhookTriggerRejectionCounters).values({
      endpointId,
      windowStart: webhookRejectionWindowStart(),
      reason: "invalid_signature",
      count: 4,
    });

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.state).toBe("revoked");
    expect(body.endpoint.endpointId).toBe(endpointId);
    expect(body.endpoint.rejectionsToday).toEqual([
      { reason: "invalid_signature", count: 4 },
    ]);
  });

  it("reports inactive when a different definition is the enabled webhook owner", async () => {
    await deployWebhookDefinition();
    const { endpointId } = await mintEndpoint();
    // This definition stops being the enabled owner (another one would hold the
    // binding). Its endpoint still exists but every delivery to it is refused.
    await db
      .update(workflowDefinitions)
      .set({ enabled: false })
      .where(eq(workflowDefinitions.id, DEFINITION_ID));

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.state).toBe("inactive");
    expect(body.endpoint.endpointId).toBe(endpointId);
  });

  it("does not heal-mint under a member and returns await_deploy", async () => {
    // A deployed, enabled owner with no row yet: an admin GET would mint, a
    // member GET must not (the heal is a write).
    await deployWebhookDefinition();
    state.sessionUserId = "user_member";

    await expect((await call(configGet, "GET", "/config")).json()).resolves.toEqual({
      state: "await_deploy",
      endpoint: null,
    });
    expect(await db.select().from(webhookTriggerEndpoints)).toEqual([]);
  });

  it("is readable by a member", async () => {
    state.sessionUserId = "user_member";

    expect((await call(configGet, "GET", "/config")).status).toBe(200);
  });
});

describe("POST .../webhook/rotate", () => {
  it("returns the new secret once and refuses a second rotation in the window", async () => {
    await deployWebhookDefinition();
    const { endpointId, secret } = await mintEndpoint();

    const first = await call(rotatePost, "POST", "/rotate", {});
    expect(first.status).toBe(200);
    const rotated = await first.json();
    expect(rotated.endpointId).toBe(endpointId);
    expect(rotated.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(rotated.secret).not.toBe(secret);
    expect(typeof rotated.previousExpiresAt).toBe("string");

    const second = await call(rotatePost, "POST", "/rotate", {});
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      data: { previousExpiresAt: rotated.previousExpiresAt },
    });

    const forced = await call(rotatePost, "POST", "/rotate", { force: true });
    expect(forced.status).toBe(200);
  });

  it("404s when the node has no endpoint", async () => {
    expect((await call(rotatePost, "POST", "/rotate", {})).status).toBe(404);
  });

  it("rejects members with 403", async () => {
    await deployWebhookDefinition();
    await mintEndpoint();
    state.sessionUserId = "user_member";

    expect((await call(rotatePost, "POST", "/rotate", {})).status).toBe(403);
  });
});

describe("POST .../webhook/reveal", () => {
  it("returns the stored secret to an admin", async () => {
    await deployWebhookDefinition();
    const { endpointId, secret } = await mintEndpoint();

    const response = await call(revealPost, "POST", "/reveal");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ endpointId, secret });
  });

  it("rejects members with 403", async () => {
    await deployWebhookDefinition();
    await mintEndpoint();
    state.sessionUserId = "user_member";

    expect((await call(revealPost, "POST", "/reveal")).status).toBe(403);
  });
});

describe("POST .../webhook/revoke and .../webhook/unrevoke", () => {
  it("revokes, then revives on a brand new secret", async () => {
    await deployWebhookDefinition();
    const { endpointId, secret } = await mintEndpoint();

    const revoked = await call(revokePost, "POST", "/revoke");
    expect(revoked.status).toBe(200);
    const revokedBody = await revoked.json();
    expect(revokedBody.endpointId).toBe(endpointId);
    expect(Date.parse(revokedBody.revokedAt)).not.toBeNaN();

    const revived = await call(unrevokePost, "POST", "/unrevoke");
    expect(revived.status).toBe(200);
    const revivedBody = await revived.json();
    expect(revivedBody.endpointId).toBe(endpointId);
    expect(revivedBody.secret).not.toBe(secret);
    const stored = await getWebhookEndpointForNode(db, DEFINITION_ID, NODE_ID);
    expect(stored?.revokedAt).toBeNull();
    // Reviving accepts nothing but the secret it just returned.
    expect(stored?.previousSecretCiphertext).toBeNull();
  });

  it("409s an unrevoke of an endpoint that is live", async () => {
    await deployWebhookDefinition();
    const { secret } = await mintEndpoint();

    const response = await call(unrevokePost, "POST", "/unrevoke");

    expect(response.status).toBe(409);
    // The live secret survived the refused revival.
    const revealed = await (await call(revealPost, "POST", "/reveal")).json();
    expect(revealed.secret).toBe(secret);
  });

  it("rejects members with 403 on both", async () => {
    await deployWebhookDefinition();
    await mintEndpoint();
    state.sessionUserId = "user_member";

    expect((await call(revokePost, "POST", "/revoke")).status).toBe(403);
    expect((await call(unrevokePost, "POST", "/unrevoke")).status).toBe(403);
  });
});

describe("GET .../webhook/deliveries", () => {
  it("returns the endpoint's recent deliveries newest first", async () => {
    await deployWebhookDefinition();
    const { endpointId } = await mintEndpoint();
    for (const deliveryId of ["d-1", "d-2"]) {
      await acceptWebhookDelivery(db, {
        endpointId,
        deliveryId,
        subjectKey: `webhook:${endpointId}:${deliveryId}`,
        definitionId: DEFINITION_ID,
        definitionVersion: 1,
        nodeId: NODE_ID,
        entry: {
          subject: "s",
          description: "d",
          requester: "r",
          priority: "p",
          payload: {},
        },
        verifiedWith: "current",
      });
    }
    await completeWebhookDelivery(db, endpointId, "d-1", {
      outcome: "started",
      reason: null,
      runId: "run-1",
      verifiedWith: "current",
    });
    // Both rows are written in the same instant, so the log's newest-first order
    // is only observable once they actually differ in age.
    await db
      .update(webhookTriggerDeliveries)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(webhookTriggerDeliveries.deliveryId, "d-1"));

    const response = await call(deliveriesGet, "GET", "/deliveries");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deliveries).toHaveLength(2);
    expect(body.deliveries.map((d: { deliveryId: string }) => d.deliveryId)).toEqual([
      "d-2",
      "d-1",
    ]);
    expect(body.deliveries[1]).toMatchObject({
      deliveryId: "d-1",
      outcome: "started",
      runId: "run-1",
      verifiedWith: "current",
    });
    expect(typeof body.deliveries[0].receivedAt).toBe("string");
  });
});

describe("POST .../webhook/test-delivery", () => {
  const PAYLOAD = {
    ticket: { id: "T-9" },
    subject: "Printer is on fire",
    description: "Smoke everywhere",
    requester: "ops@acme.test",
    priority: "urgent",
  };

  it("maps a payload, logs the probe, and starts nothing", async () => {
    await deployWebhookDefinition();
    const { endpointId } = await mintEndpoint();

    const response = await call(testDeliveryPost, "POST", "/test-delivery", {
      payload: PAYLOAD,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "test",
      reason: null,
      runId: null,
      subjectId: "T-9",
      entry: {
        subject: "Printer is on fire",
        description: "Smoke everywhere",
        requester: "ops@acme.test",
        priority: "urgent",
        payload: PAYLOAD,
      },
    });
    expect(body.deliveryId).toMatch(/^test:/);

    // Nothing was claimed and nothing was started.
    expect(mockStart).not.toHaveBeenCalled();
    expect(await db.select().from(activeRuns)).toEqual([]);

    const rows = await db.select().from(webhookTriggerDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpointId,
      deliveryId: body.deliveryId,
      pending: false,
      result: { outcome: "test", reason: null, runId: null },
    });
  });

  it("takes an identity no real delivery of the same body can collide with", async () => {
    await deployWebhookDefinition();
    const { endpointId } = await mintEndpoint();
    const rawBody = JSON.stringify(PAYLOAD);

    const probe = await (
      await call(testDeliveryPost, "POST", "/test-delivery", { payload: PAYLOAD })
    ).json();

    // The identity a real, unheadered delivery of the very same body would take.
    const realDeliveryId = fallbackWebhookDeliveryId(rawBody);
    expect(probe.deliveryId).not.toBe(realDeliveryId);
    const real = await acceptWebhookDelivery(db, {
      endpointId,
      deliveryId: realDeliveryId,
      subjectKey: `webhook:${endpointId}:T-9`,
      definitionId: DEFINITION_ID,
      definitionVersion: 1,
      nodeId: NODE_ID,
      entry: {
        subject: "Printer is on fire",
        description: "Smoke everywhere",
        requester: "ops@acme.test",
        priority: "urgent",
        payload: PAYLOAD,
      },
      verifiedWith: "current",
    });
    // A first delivery, not a replay of the probe.
    expect(real.inserted).toBe(true);
    expect(await db.select().from(webhookTriggerDeliveries)).toHaveLength(2);
  });

  it("400s a request without a payload", async () => {
    await deployWebhookDefinition();
    await mintEndpoint();

    expect(
      (await call(testDeliveryPost, "POST", "/test-delivery", { nope: 1 })).status,
    ).toBe(400);
  });

  it("409s when the definition has no deployed head to test against", async () => {
    // An endpoint minted for a version that was later rolled back to nothing.
    await deployWebhookDefinition();
    await mintEndpoint();
    await db
      .update(workflowDefinitions)
      .set({ deployedVersion: null })
      .where(eq(workflowDefinitions.id, DEFINITION_ID));

    expect(
      (await call(testDeliveryPost, "POST", "/test-delivery", { payload: PAYLOAD }))
        .status,
    ).toBe(409);
  });

  it("409s a revoked endpoint so a dead endpoint tests red", async () => {
    await deployWebhookDefinition();
    const { endpointId } = await mintEndpoint();
    await revokeWebhookEndpoint(db, endpointId);

    expect(
      (await call(testDeliveryPost, "POST", "/test-delivery", { payload: PAYLOAD }))
        .status,
    ).toBe(409);
    // The probe wrote no log row for a dead endpoint.
    expect(await db.select().from(webhookTriggerDeliveries)).toEqual([]);
  });

  it("409s when a different definition is the enabled webhook owner", async () => {
    await deployWebhookDefinition();
    await mintEndpoint();
    // This definition is still enabled+deployed with the node, but a second
    // definition holds the enabled webhook binding, so a live delivery here would
    // be refused and the probe must be too.
    await db.insert(workflowDefinitions).values({
      id: 10,
      name: "Other webhook",
      enabled: true,
      triggerTypes: ["trigger_webhook"],
      createdById: "test",
      createdByLabel: "Test",
    });
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 10,
      version: 1,
      definition: graph(),
      createdById: "test",
      createdByLabel: "Test",
    });
    await db
      .update(workflowDefinitions)
      .set({ deployedVersion: 1 })
      .where(eq(workflowDefinitions.id, 10));
    await db
      .insert(workflowDefinitionTriggers)
      .values({ triggerType: "trigger_webhook", definitionId: 10 });

    expect(
      (await call(testDeliveryPost, "POST", "/test-delivery", { payload: PAYLOAD }))
        .status,
    ).toBe(409);
  });

  it("413s a payload over the size cap", async () => {
    await deployWebhookDefinition();
    await mintEndpoint();

    const response = await call(testDeliveryPost, "POST", "/test-delivery", {
      payload: { subject: "x".repeat(600 * 1024) },
    });

    expect(response.status).toBe(413);
    expect(await db.select().from(webhookTriggerDeliveries)).toEqual([]);
  });

  it("rejects members with 403", async () => {
    await deployWebhookDefinition();
    await mintEndpoint();
    state.sessionUserId = "user_member";

    expect(
      (await call(testDeliveryPost, "POST", "/test-delivery", { payload: PAYLOAD }))
        .status,
    ).toBe(403);
  });
});
