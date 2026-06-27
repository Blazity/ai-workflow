import { eq } from "drizzle-orm";
import { createApp, toWebHandler } from "h3";
import { Webhook } from "svix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import {
  invitation,
  inviteEmailDelivery,
  organization,
  user,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";

const WEBHOOK_SECRET = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {
    RESEND_WEBHOOK_SECRET: "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" as string | undefined,
  },
}));

vi.mock("../../../env.js", () => ({
  env: state.env,
}));

vi.mock("../../db/client.js", () => ({
  getDb: () => state.db,
}));

const resendHandler = (await import("./resend.post.js")).default;

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  state.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;

  await db.insert(user).values({
    id: "user_owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
  });
  await db.insert(invitation).values({
    id: "invite_acme",
    organizationId: "org_acme",
    email: "new.user@example.com",
    role: "member",
    status: "pending",
    expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    inviterId: "user_owner",
  });
  await db.insert(inviteEmailDelivery).values({
    id: "delivery_acme",
    invitationId: "invite_acme",
    resendEmailId: "email_123",
    status: "sent",
  });
});

function makeApp() {
  const app = createApp();
  app.use("/", resendHandler);
  return toWebHandler(app);
}

function signedRequest(payload: unknown, secret = WEBHOOK_SECRET): Request {
  const body = JSON.stringify(payload);
  const webhook = new Webhook(secret);
  const id = "msg_123";
  const timestamp = new Date();
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": webhook.sign(id, timestamp, body),
    },
    body,
  });
}

async function delivery() {
  const [row] = await db
    .select({
      status: inviteEmailDelivery.status,
      error: inviteEmailDelivery.error,
    })
    .from(inviteEmailDelivery)
    .where(eq(inviteEmailDelivery.resendEmailId, "email_123"));
  return row;
}

describe("POST /webhooks/resend", () => {
  it("returns 401 when signature headers are missing", async () => {
    const res = await makeApp()(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "email.delivered" }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 500 when the webhook secret is not configured", async () => {
    state.env.RESEND_WEBHOOK_SECRET = undefined;

    const res = await makeApp()(signedRequest({ type: "email.delivered" }));

    expect(res.status).toBe(500);
  });

  it("updates invite delivery status for signed bounced events", async () => {
    const res = await makeApp()(
      signedRequest({
        type: "email.bounced",
        data: {
          email_id: "email_123",
          bounce: {
            message: "Mailbox unavailable",
            type: "hard_bounce",
            subType: "general",
          },
        },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    await expect(delivery()).resolves.toEqual({
      status: "bounced",
      error: "Mailbox unavailable",
    });
  });

  it("updates invite delivery status for signed failure events", async () => {
    const res = await makeApp()(
      signedRequest({
        type: "email.complained",
        data: { email_id: "email_123" },
      }),
    );

    expect(res.status).toBe(200);
    await expect(delivery()).resolves.toEqual({
      status: "failed",
      error: "Recipient complained",
    });
  });

  it("accepts unknown message ids without throwing", async () => {
    const res = await makeApp()(
      signedRequest({
        type: "email.bounced",
        data: {
          email_id: "unknown",
          bounce: { message: "Unknown row", type: "hard_bounce", subType: "general" },
        },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    await expect(delivery()).resolves.toEqual({ status: "sent", error: null });
  });

  it("accepts unrelated signed events without tracking reset password delivery", async () => {
    const res = await makeApp()(
      signedRequest({
        type: "contact.created",
        data: { id: "contact_123", email: "user@example.com" },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    await expect(delivery()).resolves.toEqual({ status: "sent", error: null });
  });
});
