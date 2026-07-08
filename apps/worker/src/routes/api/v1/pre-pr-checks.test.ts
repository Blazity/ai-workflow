import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { savePrePrCheckConfig } from "../../../pre-pr-checks/store.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
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

const checksGet = (await import("./pre-pr-checks.get.js")).default;
const checksPut = (await import("./pre-pr-checks.put.js")).default;
const restorePost = (await import("./pre-pr-checks/restore.post.js")).default;
const sessionGet = (await import("./session.get.js")).default;

const VALID_CONFIG = {
  repositories: [{ provider: "github" as const, repoPath: "acme/web", commands: ["pnpm test"] }],
};
const ACTOR = { actorRole: "admin" as const, actorId: "user_admin", actorLabel: "Admin" };

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://worker.test/", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

describe("GET /api/v1/pre-pr-checks", () => {
  it("returns empty state when nothing was saved", async () => {
    const res = await handlerFor(checksGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ current: null, versions: [] });
  });

  it("returns current + versions newest first", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: { repositories: [] } });
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    const res = await handlerFor(checksGet)(new Request("http://worker.test/"));
    const body = await res.json();
    expect(body.current.version).toBe(2);
    expect(body.current.config).toEqual(VALID_CONFIG);
    expect(typeof body.current.createdAt).toBe("string");
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });
});

describe("PUT /api/v1/pre-pr-checks", () => {
  it("saves a valid config and returns the new version", async () => {
    const res = await handlerFor(checksPut)(jsonRequest("PUT", { config: VALID_CONFIG }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(1);
    expect(body.version.config).toEqual(VALID_CONFIG);
    expect(body.version.createdByLabel).toBe("Admin");
  });

  it("rejects invalid config with 400 and named field", async () => {
    const res = await handlerFor(checksPut)(
      jsonRequest("PUT", {
        config: { repositories: [{ provider: "github", repoPath: "acme/web", commands: [] }] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(checksPut)(jsonRequest("PUT", { config: VALID_CONFIG }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/pre-pr-checks/restore", () => {
  it("appends a copy of the requested version", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    await savePrePrCheckConfig(db, { ...ACTOR, config: { repositories: [] } });
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(3);
    expect(body.version.config).toEqual(VALID_CONFIG);
    expect(body.version.restoredFromVersion).toBe(1);
  });

  it("404s on an unknown version", async () => {
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 42 }));
    expect(res.status).toBe(404);
  });

  it("rejects members with 403", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: VALID_CONFIG });
    state.sessionUserId = "user_member";
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/session", () => {
  it("reports canEditChecks per role", async () => {
    let res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect((await res.json()).canEditChecks).toBe(true);

    state.sessionUserId = "user_member";
    res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect((await res.json()).canEditChecks).toBe(false);
  });
});
