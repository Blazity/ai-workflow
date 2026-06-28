import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { invitation, member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_owner",
  resendSend: vi.fn(),
  env: {
    DASHBOARD_ORG_NAME: "AI Workflow",
    DASHBOARD_ORG_SLUG: "ai-workflow",
    DASHBOARD_ORIGIN: "https://dashboard.example.com",
    RESEND_API_KEY: "re_test",
    RESEND_FROM_EMAIL: "AI Workflow <noreply@example.com>",
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

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: state.resendSend,
    };
  },
}));

const invitesGet = (await import("./invites.get.js")).default;
const invitesPost = (await import("./invites.post.js")).default;
const resendPost = (await import("./invites/[inviteId]/resend.post.js")).default;
const cancelPost = (await import("./invites/[inviteId]/cancel.post.js")).default;

let db: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_owner";
  state.resendSend.mockResolvedValue({
    data: { id: "email_123" },
    error: null,
    headers: null,
  });

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
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function inviteHandlerFor(route: typeof resendPost, inviteId: string) {
  const app = createApp();
  app.use(
    "/",
    eventHandler((event) => {
      event.context.params = { inviteId };
      return route(event);
    }),
  );
  return toWebHandler(app);
}

async function inviteCount(): Promise<number> {
  return (await db.select().from(invitation)).length;
}

describe("invites API", () => {
  it("returns 400 when invite creation has no body", async () => {
    const res = await handlerFor(invitesPost)(
      new Request("http://localhost/", { method: "POST" }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects member invite creation", async () => {
    state.sessionUserId = "user_member";

    const res = await handlerFor(invitesPost)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new.user@example.com" }),
      }),
    );

    expect(res.status).toBe(403);
  });

  it("keeps invite when Resend rejects synchronously", async () => {
    state.resendSend.mockResolvedValueOnce({
      data: null,
      error: { name: "validation_error", message: "Bad sender", statusCode: 422 },
      headers: null,
    });

    const res = await handlerFor(invitesPost)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new.user@example.com" }),
      }),
    );

    expect(res.status).toBe(502);
    await expect(inviteCount()).resolves.toBe(1);
  });

  it("creates, lists, resends, and cancels invites for owner/admin", async () => {
    const created = await handlerFor(invitesPost)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new.user@example.com" }),
      }),
    );
    expect(created.status).toBe(200);
    expect(state.resendSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tags: [expect.objectContaining({ name: "invite_delivery_id" })],
      }),
    );
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      email: "new.user@example.com",
      role: "member",
      emailStatus: "queued",
    });

    const listed = await handlerFor(invitesGet)(new Request("http://localhost/"));
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      invites: [expect.objectContaining({ id: createdBody.id })],
    });

    state.sessionUserId = "user_admin";
    state.resendSend.mockResolvedValueOnce({
      data: { id: "email_456" },
      error: null,
      headers: null,
    });
    const resent = await inviteHandlerFor(resendPost, createdBody.id)(
      new Request("http://localhost/", { method: "POST" }),
    );
    expect(resent.status).toBe(200);
    await expect(resent.json()).resolves.toMatchObject({ emailStatus: "queued" });

    const canceled = await inviteHandlerFor(cancelPost, createdBody.id)(
      new Request("http://localhost/", { method: "POST" }),
    );
    expect(canceled.status).toBe(200);
    await expect(canceled.json()).resolves.toMatchObject({ status: "canceled" });
  });
});
