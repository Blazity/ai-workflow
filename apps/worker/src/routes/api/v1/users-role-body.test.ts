import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
  },
}));

vi.mock("h3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("h3")>();
  return {
    ...actual,
    toWebRequest: vi.fn(() => {
      throw new Error("toWebRequest must not be needed for header-only auth");
    }),
  };
});

vi.mock("../../../../env.js", () => ({
  env: state.env,
}));

vi.mock("../../../db/client.js", () => ({
  getDb: () => state.db,
}));

vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: "user_owner" },
        session: { id: "session_test" },
      })),
    },
  },
}));

const rolePatch = (await import("./users/[userId]/role.patch.js")).default;

let db: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;

  await db.insert(organization).values({
    id: "org_aiw",
    name: "AI Workflow",
    slug: "ai-workflow",
  });
  await db.insert(user).values([
    {
      id: "user_owner",
      name: "Owner",
      email: "owner@example.com",
      emailVerified: true,
    },
    {
      id: "user_member",
      name: "Member",
      email: "member@example.com",
      emailVerified: true,
    },
  ]);
  await db.insert(member).values([
    {
      id: "member_owner",
      organizationId: "org_aiw",
      userId: "user_owner",
      role: "owner",
    },
    {
      id: "member_member",
      organizationId: "org_aiw",
      userId: "user_member",
      role: "member",
    },
  ]);
});

function roleHandlerFor(userId: string) {
  const app = createApp();
  app.use(
    "/",
    eventHandler((event) => {
      event.context.params = { userId };
      return rolePatch(event);
    }),
  );
  return toWebHandler(app);
}

describe("role PATCH body handling", () => {
  it("does not convert the body-bearing request to a Web Request before reading JSON", async () => {
    const res = await roleHandlerFor("user_member")(
      new Request("http://localhost/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      userId: "user_member",
      role: "admin",
    });
  });
});
