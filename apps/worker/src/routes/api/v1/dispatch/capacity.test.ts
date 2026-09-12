import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../../db/client.js";
import { member, organization, user } from "../../../../db/schema.js";
import { createTestDb } from "../../../../db/test-db.js";
import { writeManyConnectedSettings } from "../../../../db/repositories/settings.js";

/**
 * The HTTP entry of the settings snapshot.
 *
 * The capacity card is the smallest route that publishes a migrated value
 * verbatim, so it is where "an operator's stored decision beats the variable
 * this deployment booted with" is observable end to end: no stored row answers
 * from the environment exactly as before, and one stored row answers with the
 * stored number without a redeploy.
 */

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
    DASHBOARD_ORG_NAME: "AI Workflow",
    MAX_CONCURRENT_AGENTS: 3,
  } as Record<string, unknown>,
}));

vi.mock("../../../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../../services/auth/auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: "user_admin" },
        session: { id: "session_test" },
      })),
    },
  },
}));
vi.mock("../../../../engine/support/adapters.js", () => ({
  createAdapters: () => ({ runRegistry: { kind: "run-registry" } }),
}));
vi.mock("../../../../services/dispatch/dispatch.js", () => ({
  capacityConsumerCount: async () => 1,
}));
vi.mock("../../../../db/repositories/dispatch-capacity-queue.js", () => ({
  listConnectedQueuedDispatchTickets: async () => [],
}));

const capacityGet = (await import("./capacity.get.js")).default;

let db: Db;

function request(): Promise<Response> {
  const app = createApp();
  app.use("/", capacityGet);
  return toWebHandler(app)(new Request("http://worker.test/"));
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;
  state.env.MAX_CONCURRENT_AGENTS = 3;
  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db
    .insert(user)
    .values({ id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true });
  await db.insert(member).values({
    id: "member_admin",
    organizationId: "org_aiw",
    userId: "user_admin",
    role: "admin",
  });
});

describe("GET /api/v1/dispatch/capacity and the settings snapshot", () => {
  it("answers from the environment while the table holds no decision", async () => {
    const res = await request();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ maxSlots: 3 });
  });

  it("answers with the stored row once an operator has decided", async () => {
    await writeManyConnectedSettings({
      patch: { MAX_CONCURRENT_AGENTS: 9 },
      actor: "user_admin",
      reason: "capacity raised for the release window",
    });

    const res = await request();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ maxSlots: 9 });
    // The variable is untouched: the row is what changed the answer.
    expect(state.env.MAX_CONCURRENT_AGENTS).toBe(3);
  });
});
