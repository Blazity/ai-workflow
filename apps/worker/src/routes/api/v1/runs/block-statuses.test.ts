import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../../db/client.js";
import { member, organization, user } from "../../../../db/schema.js";
import { createTestDb } from "../../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin" as string | null,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        state.sessionUserId
          ? { user: { id: state.sessionUserId }, session: { id: "session_test" } }
          : null,
      ),
    },
  },
}));
// The guard runs before any registry work; an empty registry keeps the
// authorized case on the collector's "nothing qualifies" path.
vi.mock("../../../../lib/adapters.js", () => ({
  createAdapters: () => ({ runRegistry: { listAll: async () => [] } }),
}));

const blockStatusesGet = (await import("./block-statuses.get.js")).default;

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_outsider", name: "Outsider", email: "outsider@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
  ]);
});

// This route shipped without the org guard that its workflow-definition and approvals
// siblings carry, so the guard is asserted here directly rather than inferred from them.
describe("GET /api/v1/runs/block-statuses", () => {
  it("rejects a request with no session with 401", async () => {
    state.sessionUserId = null;
    const res = await handlerFor(blockStatusesGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(401);
  });

  it("rejects a user outside the dashboard org with 403", async () => {
    state.sessionUserId = "user_outsider";
    const res = await handlerFor(blockStatusesGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(403);
  });

  it("allows a member of the dashboard org", async () => {
    const res = await handlerFor(blockStatusesGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
  });
});
