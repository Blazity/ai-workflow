import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "../../../../auth.js";
import type { Auth } from "../../../../auth.js";
import type { Db } from "../../../../db/client.js";
import { invitation, organization, user } from "../../../../db/schema.js";
import { createTestDb } from "../../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  auth: undefined as unknown,
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
  },
}));

vi.mock("../../../../../env.js", () => ({
  env: state.env,
}));

vi.mock("../../../../db/client.js", () => ({
  getDb: () => state.db,
}));

vi.mock("../../../../auth-instance.js", () => ({
  get auth() {
    return state.auth;
  },
}));

const acceptRoute = (await import("./accept.post.js")).default;

let db: Db;
let auth: Auth;

beforeEach(async () => {
  db = await createTestDb();
  auth = createAuth(db, {
    secret: "x".repeat(32),
    baseURL: "http://localhost:3000",
    trustedOrigins: ["http://localhost:3001"],
  });
  state.db = db;
  state.auth = auth;

  await db.insert(organization).values({
    id: "org_aiw",
    name: "AI Workflow",
    slug: "ai-workflow",
  });
  await db.insert(user).values({
    id: "user_owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
  });
  await db.insert(invitation).values({
    id: "invite_1",
    organizationId: "org_aiw",
    email: "invited@example.com",
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    inviterId: "user_owner",
  });
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

describe("invite accept API", () => {
  it("rejects missing body fields", async () => {
    const res = await handlerFor(acceptRoute)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteId: "invite_1" }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON before field validation", async () => {
    const res = await handlerFor(acceptRoute)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      statusMessage: "Invalid request body",
    });
  });

  it.each([
    { body: null },
    { body: [] },
    { body: { inviteId: 123, password: "password123" } },
    { body: { inviteId: "invite_1", password: 123 } },
    { body: { inviteId: "invite_1", password: "password123", name: 123 } },
  ])("rejects invalid body shape %# before calling invite acceptance", async ({ body }) => {
    const res = await handlerFor(acceptRoute)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      statusMessage: "Invalid request body",
    });
  });

  it("accepts an invite and returns a session token", async () => {
    const res = await handlerFor(acceptRoute)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteId: "invite_1",
          name: "Invited User",
          password: "password123",
        }),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      token: expect.any(String),
      user: {
        email: "invited@example.com",
        name: "Invited User",
      },
    });
  });
});
