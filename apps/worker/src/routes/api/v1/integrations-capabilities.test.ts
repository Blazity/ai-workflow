import { createApp, toWebHandler, type EventHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: { user: { id: "user_member" }, session: { id: "session_test" } } as unknown,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../db/client.js")>()),
  getDb: () => state.db,
}));
vi.mock("../../../services/auth/auth-instance.js", () => ({
  auth: { api: { getSession: vi.fn(async () => state.session) } },
}));

const capabilitiesGet = (await import("./integrations/capabilities.get.js")).default;

function handlerFor(route: EventHandler) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  state.session = { user: { id: "user_member" }, session: { id: "session_test" } };
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

describe("GET /api/v1/integrations/capabilities", () => {
  it("answers a member, because who serves memory is not a credential", async () => {
    const res = await handlerFor(capabilitiesGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: { id: string; serving: unknown }[] };
    expect(body.capabilities.find((row) => row.id === "memory")?.serving).toEqual({
      kind: "builtin",
      name: "Built-in memory",
    });
  });

  it("answers nobody who is not signed in", async () => {
    state.session = null;
    const res = await handlerFor(capabilitiesGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(401);
  });
});
