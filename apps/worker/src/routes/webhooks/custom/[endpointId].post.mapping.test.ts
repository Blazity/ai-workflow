import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import {
  workflowDefinitions,
  workflowDefinitionTriggers,
  workflowDefinitionVersions,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { mintWebhookEndpointsForDefinition } from "../../../webhook-trigger/endpoint-store.js";
import { triggerOutputWithTicketContext } from "../../../workflows/agent.js";

/**
 * End-to-end mapping coverage for the webhook ingress, complementary to
 * `[endpointId].post.test.ts` (which pins the default field names, redelivery
 * dedupe, and the auth failures). This file adds the one angle that file does
 * not: a delivery whose payload maps through a NON-DEFAULT `subjectPath`/`map*`
 * config, driven all the way through the route, the real dispatch, and the real
 * store, and then the trigger-output contract pinned via the production
 * `triggerOutputWithTicketContext` so the mapped entry and `steps.entry.output.*`
 * are proven identical end to end.
 */

const KEY = "a".repeat(64);
const DEFINITION_ID = 11;
const NODE_ID = "entry";

/** Every field is pulled from a nested path the block defaults would never
 *  reach, so a clean map proves the endpoint's own map* config drives the entry,
 *  not the built-in field names. */
const MAPPING_CONFIG = {
  subjectPath: "issue.key",
  mapSubject: "issue.title",
  mapDescription: "issue.body",
  mapRequester: "reporter.email",
  mapPriority: "issue.severity",
};

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

function graph(configuration: Record<string, unknown>) {
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
  issue: {
    key: "OPS-42",
    title: "Printer is on fire",
    body: "Smoke everywhere in the office",
    severity: "urgent",
  },
  reporter: { email: "ops@acme.test" },
});

function signed(headers: Record<string, string> = {}): Request {
  return new Request(`http://worker.test/webhooks/custom/${endpointId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(BODY, "utf8")),
      "x-workflow-signature": createHmac("sha256", secret).update(BODY).digest("hex"),
      ...headers,
    },
    body: BODY,
  });
}

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  state.env.WEBHOOK_TRIGGER_ENCRYPTION_KEY = KEY;
  state.env.MAX_CONCURRENT_AGENTS = 3;
  mockStart.mockReset().mockResolvedValue({ runId: "run-1" });

  await db.insert(workflowDefinitions).values({
    id: DEFINITION_ID,
    name: "Webhook triage",
    enabled: true,
    triggerTypes: ["trigger_webhook"],
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: DEFINITION_ID,
    version: 1,
    definition: graph(MAPPING_CONFIG),
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
    nodes: graph(MAPPING_CONFIG).nodes,
  });
  endpointId = minted[0]!.endpointId;
  secret = minted[0]!.secret!;
});

describe("POST /webhooks/custom/:endpointId (non-default mapping)", () => {
  it("maps nested payload paths into the entry and pins the trigger output contract", async () => {
    const response = await handler()(signed({ "x-delivery-id": "d-map" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "dispatched",
      runId: "run-1",
    });

    const body = JSON.parse(BODY);
    const input = mockStart.mock.calls[0]?.[1]?.[0];
    // The endpoint's map* config, not the default field names, produced the
    // entry, and subjectPath resolved issue.key into the subject key.
    expect(input).toMatchObject({
      kind: "webhook_trigger",
      endpointId,
      definitionId: DEFINITION_ID,
      definitionVersion: 1,
      nodeId: NODE_ID,
      deliveryId: "d-map",
      subjectKey: `webhook:${endpointId}:OPS-42`,
      entry: {
        subject: "Printer is on fire",
        description: "Smoke everywhere in the office",
        requester: "ops@acme.test",
        priority: "urgent",
        payload: body,
      },
    });

    // The mapping-to-entry-output contract, end to end: what the trigger block
    // publishes as steps.entry.output.* is exactly the mapped entry, so a
    // downstream {{data:steps.entry.output.subject}} reads the mapped value.
    expect(triggerOutputWithTicketContext(input)).toEqual({
      status: "fired",
      subject: "Printer is on fire",
      description: "Smoke everywhere in the office",
      requester: "ops@acme.test",
      priority: "urgent",
      payload: body,
    });
    expect(mockStart).toHaveBeenCalledOnce();
  });
});
