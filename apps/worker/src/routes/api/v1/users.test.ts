import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { account, member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_owner",
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
  },
}));

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
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));

const usersGet = (await import("./users.get.js")).default;
const rolePatch = (await import("./users/[userId]/role.patch.js")).default;

let db: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_owner";
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
      id: "user_admin",
      name: "Admin",
      email: "admin@example.com",
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
      id: "member_admin",
      organizationId: "org_aiw",
      userId: "user_admin",
      role: "admin",
    },
    {
      id: "member_member",
      organizationId: "org_aiw",
      userId: "user_member",
      role: "member",
    },
  ]);
  await db.insert(account).values({
    id: "account_owner_password",
    userId: "user_owner",
    accountId: "user_owner",
    providerId: "credential",
  });
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

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

describe("users API", () => {
  it("returns 403 for members", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(usersGet)(new Request("http://localhost/"));

    expect(res.status).toBe(403);
  });

  it("lists users for owners", async () => {
    const res = await handlerFor(usersGet)(new Request("http://localhost/"));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user_owner",
          email: "owner@example.com",
          role: "owner",
          authMethod: "Password",
        }),
      ]),
    );
  });

  it("lets owner update member role and rejects admin role updates", async () => {
    const ownerRes = await roleHandlerFor("user_member")(
      new Request("http://localhost/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      }),
    );

    expect(ownerRes.status).toBe(200);
    await expect(ownerRes.json()).resolves.toMatchObject({
      userId: "user_member",
      role: "admin",
    });

    state.sessionUserId = "user_admin";
    const adminRes = await roleHandlerFor("user_member")(
      new Request("http://localhost/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      }),
    );
    expect(adminRes.status).toBe(403);
  });
});
