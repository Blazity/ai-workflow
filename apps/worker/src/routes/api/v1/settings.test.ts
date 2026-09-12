import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsEntryView } from "@shared/contracts";
import type { Db } from "../../../db/client.js";
import { member, organization, settings, settingsVersions, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin" as string | null,
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
    DASHBOARD_ORG_NAME: "AI Workflow",
    MAX_CONCURRENT_AGENTS: 3,
    COLUMN_AI: "AI",
    MCP_MAX_REQUEST_BYTES: 1_048_576,
    MCP_MAX_RESULT_BYTES: 524_288,
  } as Record<string, unknown>,
}));

vi.mock("../../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../services/auth/auth-instance.js", () => ({
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

const settingsGet = (await import("./settings.get.js")).default;
const settingsPatch = (await import("./settings.patch.js")).default;

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function get(query = ""): Promise<Response> {
  return handlerFor(settingsGet)(new Request(`http://worker.test/${query}`));
}

function patch(body: unknown): Promise<Response> {
  return handlerFor(settingsPatch)(
    new Request("http://worker.test/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function entry(settings: SettingsEntryView[], key: string): SettingsEntryView {
  const found = settings.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no entry for ${key}`);
  return found;
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  db = await createTestDb();
  state.db = db;
  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db
    .insert(user)
    .values({ id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true });
  await db
    .insert(member)
    .values({ id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" });
  await db
    .insert(user)
    .values({ id: "user_member", name: "Member", email: "member@example.com", emailVerified: true });
  await db.insert(member).values({
    id: "member_member",
    organizationId: "org_aiw",
    userId: "user_member",
    role: "member",
  });
  await db
    .insert(user)
    .values({ id: "user_owner", name: "Owner", email: "owner@example.com", emailVerified: true });
  await db.insert(member).values({
    id: "member_owner",
    organizationId: "org_aiw",
    userId: "user_owner",
    role: "owner",
  });
});

describe("GET /api/v1/settings", () => {
  it("answers every registry key with its resolved value and source", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.length).toBeGreaterThan(30);
    expect(entry(body.settings, "MAX_CONCURRENT_AGENTS")).toMatchObject({
      value: 3,
      default: 3,
      source: "default",
      group: "capacity",
      appliesToRunsInFlight: "immediate",
      lastVersion: null,
    });
    expect(entry(body.settings, "catalog.activated")).toMatchObject({
      value: false,
      group: "repositories",
    });
  });

  it("is open to a member", async () => {
    state.sessionUserId = "user_member";
    const res = await get();
    expect(res.status).toBe(200);
  });

  it("refuses a request without a session", async () => {
    state.sessionUserId = null;
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("answers one key's history and refuses a key that is not a setting", async () => {
    await patch({ settings: { COLUMN_AI: "Agent" }, reason: "renamed the column" });

    const res = await get("?key=COLUMN_AI");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({
      key: "COLUMN_AI",
      previousValue: null,
      newValue: "Agent",
      actor: "user_admin",
      reason: "renamed the column",
    });
    expect(typeof body.versions[0].createdAt).toBe("string");

    const unknown = await get("?key=NOT_A_SETTING");
    expect(unknown.status).toBe(400);
  });
});

describe("PATCH /api/v1/settings", () => {
  it("stores the patch and answers with the updated settings and the versions", async () => {
    const res = await patch({
      settings: { MAX_CONCURRENT_AGENTS: 5, COLUMN_AI: "Agent" },
      reason: "opening up",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(entry(body.settings, "MAX_CONCURRENT_AGENTS")).toMatchObject({
      value: 5,
      source: "stored",
    });
    expect(entry(body.settings, "MAX_CONCURRENT_AGENTS").lastVersion).toMatchObject({
      newValue: 5,
      reason: "opening up",
    });
    expect(body.versions.map((version: { key: string }) => version.key)).toEqual([
      "COLUMN_AI",
      "MAX_CONCURRENT_AGENTS",
    ]);
  });

  it("refuses the repository catalog switch with 400 and writes nothing", async () => {
    // Activation names the repositories that hold an active claim and are not
    // enabled; a generic patch would flip the flag without showing any of it.
    const res = await patch({
      settings: { MAX_CONCURRENT_AGENTS: 5, "catalog.activated": true },
      reason: "skipping the dialog",
    });

    expect(res.status).toBe(400);
    expect(res.statusText).toContain("catalog.activated");
    expect(res.statusText).toContain("/api/v1/repository-catalog/activate");
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
    await expect(db.select().from(settings)).resolves.toHaveLength(0);
  });

  it("refuses a key the running code reads from the environment, naming that key", async () => {
    // `PRE_PR_CHECKS_ALLOWED_ENV` is the operator-side gate on which of the
    // worker's secrets a tenant's command may be handed, and the checks runner
    // reads the variable inside the step. A row here would be recorded, shown
    // on the page, and ignored by the resolution, so the patch is refused and
    // says where the decision lives instead.
    const res = await patch({
      settings: { PRE_PR_CHECKS_ALLOWED_ENV: ["NPM_TOKEN"], "catalog.activated": true },
      reason: "widening the allowlist",
    });

    expect(res.status).toBe(400);
    // Both refusals, each with its own reason: one patch can carry both.
    expect(res.statusText).toContain("PRE_PR_CHECKS_ALLOWED_ENV");
    expect(res.statusText).toContain("read from the deployment environment");
    expect(res.statusText).toContain("catalog.activated");
    expect(res.statusText).toContain("/api/v1/repository-catalog/activate");
    await expect(db.select().from(settings)).resolves.toHaveLength(0);
  });

  it("lets an owner write", async () => {
    state.sessionUserId = "user_owner";
    const res = await patch({
      settings: { MAX_CONCURRENT_AGENTS: 4 },
      reason: "owner decides",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(entry(body.settings, "MAX_CONCURRENT_AGENTS")).toMatchObject({
      value: 4,
      source: "stored",
    });
    expect(body.versions[0]).toMatchObject({ actor: "user_owner" });
  });

  it("refuses a member with 403 and writes nothing", async () => {
    state.sessionUserId = "user_member";
    const res = await patch({
      settings: { MAX_CONCURRENT_AGENTS: 5 },
      reason: "trying",
    });
    expect(res.status).toBe(403);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
  });

  it("refuses an unknown key with 400 and writes nothing", async () => {
    const res = await patch({
      settings: { MAX_CONCURRENT_AGENTS: 5, NOT_A_SETTING: 1 },
      reason: "typo",
    });
    expect(res.status).toBe(400);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
  });

  it("refuses a wrong type with 400 and writes nothing", async () => {
    const res = await patch({
      settings: { MAX_CONCURRENT_AGENTS: "many" },
      reason: "typo",
    });
    expect(res.status).toBe(400);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
  });

  it("refuses a value below the declared minimum with 400 and writes nothing", async () => {
    const res = await patch({
      settings: { MAX_CONCURRENT_AGENTS: 0 },
      reason: "stopping everything",
    });

    expect(res.status).toBe(400);
    expect(res.statusText).toContain("MAX_CONCURRENT_AGENTS");
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
  });

  it("refuses a value outside the declared set with 400 and writes nothing", async () => {
    const res = await patch({
      settings: { AGENT_KIND: "gemini" },
      reason: "trying a third agent",
    });

    expect(res.status).toBe(400);
    expect(res.statusText).toContain("AGENT_KIND");
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
  });

  it("refuses an MCP result limit above the request limit with 400", async () => {
    const res = await patch({
      settings: { MCP_MAX_RESULT_BYTES: 4_000_000 },
      reason: "bigger answers",
    });

    expect(res.status).toBe(400);
    expect(res.statusText).toContain("MCP_MAX_RESULT_BYTES");
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
  });

  it("refuses a body with no reason", async () => {
    const res = await patch({ settings: { MAX_CONCURRENT_AGENTS: 5 } });
    expect(res.status).toBe(400);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
  });
});
