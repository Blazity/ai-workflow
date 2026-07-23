import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_member" as string | null,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        state.sessionUserId === null
          ? null
          : {
              user: { id: state.sessionUserId },
              session: { id: "session_test" },
            },
      ),
    },
  },
}));

const inspectPost = (await import("./json-schema/inspect.post.js")).default;

let db: Db;

function handler() {
  const app = createApp();
  app.use("/", inspectPost);
  return toWebHandler(app);
}

beforeEach(async () => {
  state.sessionUserId = "user_member";
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({
    id: "org_aiw",
    name: "AI Workflow",
    slug: "ai-workflow",
  });
  await db.insert(user).values({
    id: "user_member",
    name: "Member",
    email: "member@example.com",
    emailVerified: true,
  });
  await db.insert(member).values({
    id: "member_member",
    organizationId: "org_aiw",
    userId: "user_member",
    role: "member",
  });
});

describe("POST /api/v1/json-schema/inspect", () => {
  it("lets an authenticated organization member inspect an exact raw schema", async () => {
    const response = await handler()(
      new Request("http://worker.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source:
            '{ "type": "object", "properties": { "ok": { "type": "boolean" } } }',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      deployable: true,
      dialect: "https://json-schema.org/draft/2020-12/schema",
      valueSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
      },
      issues: [],
    });
  });

  it("returns exact unsupported-keyword paths without discarding parsed source", async () => {
    const response = await handler()(
      new Request("http://worker.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: '{"type":"array","items":{"type":"string","minLength":1}}',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deployable: false,
      schema: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      issues: [
        {
          code: "unsupported_keyword",
          path: "/items/minLength",
        },
      ],
    });
  });

  it("rejects unauthenticated callers", async () => {
    state.sessionUserId = null;
    const response = await handler()(
      new Request("http://worker.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: '{"type":"string"}' }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("requires the source string", async () => {
    const response = await handler()(
      new Request("http://worker.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
  });
});
