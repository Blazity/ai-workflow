import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_LIST_ENTRY_RULE, type SettingsEntryView } from "@shared/contracts";
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
const settingsReset = (await import("./settings/reset.post.js")).default;

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

function reset(body: unknown): Promise<Response> {
  return handlerFor(settingsReset)(
    new Request("http://worker.test/", {
      method: "POST",
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
    // Core's 27 and Slack's allowlist, which an integration declares.
    expect(body.settings).toHaveLength(28);
    expect(entry(body.settings, "SLACK_ALLOWED_USER_IDS")).toMatchObject({
      value: [],
      default: [],
      source: "default",
      group: "integrations",
      appliesToRunsInFlight: "immediate",
    });
    expect(entry(body.settings, "MAX_CONCURRENT_AGENTS")).toMatchObject({
      value: 3,
      default: 3,
      source: "default",
      group: "capacity",
      appliesToRunsInFlight: "immediate",
      lastVersion: null,
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

  it("names the person behind each change, not their user id", async () => {
    // QA read "user A2FzRCBJ5e0eMggEB4N8D2pcWASWphDW" in the history. The id
    // stays for tools; the label is what a person reads.
    await patch({ settings: { COLUMN_AI: "Agent" }, reason: "renamed the column" });
    await db.insert(settingsVersions).values({
      key: "COLUMN_AI",
      previousValue: "Agent",
      newValue: "AI",
      actor: "migration",
      reason: "seeded",
    });

    const history = await (await get("?key=COLUMN_AI")).json();
    expect(
      history.versions.map((version: { actor: string; actorLabel: string }) => [
        version.actor,
        version.actorLabel,
      ]),
    ).toEqual([
      ["migration", "migration"],
      ["user_admin", "Admin"],
    ]);

    const listing = await (await get()).json();
    expect(entry(listing.settings, "COLUMN_AI").lastVersion).toMatchObject({
      actor: "migration",
      actorLabel: "migration",
    });
  });

  it("says what answers for each key once its stored row is gone", async () => {
    await patch({ settings: { MAX_CONCURRENT_AGENTS: 7 }, reason: "more" });
    const listing = await (await get()).json();
    expect(entry(listing.settings, "MAX_CONCURRENT_AGENTS")).toMatchObject({
      value: 7,
      source: "stored",
      fallback: { value: 3, source: "default" },
    });
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

  it("stores an integration's setting like any other, with its history, and refuses a wrong type", async () => {
    // Slack's allowlist: an operator adds a colleague from the Settings page.
    const res = await patch({
      settings: { SLACK_ALLOWED_USER_IDS: ["U01", "U02"] },
      reason: "Ada joins the on-call rota",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(entry(body.settings, "SLACK_ALLOWED_USER_IDS")).toMatchObject({
      value: ["U01", "U02"],
      source: "stored",
    });
    expect(entry(body.settings, "SLACK_ALLOWED_USER_IDS").lastVersion).toMatchObject({
      newValue: ["U01", "U02"],
      reason: "Ada joins the on-call rota",
    });

    const wrong = await patch({ settings: { SLACK_ALLOWED_USER_IDS: "U01,U02" }, reason: "typed" });
    expect(wrong.status).toBe(400);
    expect(wrong.statusText).toContain("SLACK_ALLOWED_USER_IDS (wrong_type)");

    // Two ids typed into one entry would be one id nobody has, which locks
    // everyone out; the refusal says what to send instead.
    const joined = await patch({ settings: { SLACK_ALLOWED_USER_IDS: ["U01,U02"] }, reason: "typed" });
    expect(joined.status).toBe(400);
    expect(joined.statusText).toContain("SLACK_ALLOWED_USER_IDS (list_entry_invalid)");
    expect(joined.statusText).toContain(SETTING_LIST_ENTRY_RULE);
    expect(await db.select().from(settings)).toEqual([
      expect.objectContaining({ key: "SLACK_ALLOWED_USER_IDS", value: ["U01", "U02"] }),
    ]);
  });

  it("refuses a key the running code reads from the environment, naming that key", async () => {
    // `PRE_PR_CHECKS_ALLOWED_ENV` is the operator-side gate on which of the
    // worker's secrets a tenant's command may be handed, and the checks runner
    // reads the variable inside the step. A row here would be recorded, shown
    // on the page, and ignored by the resolution, so the patch is refused and
    // says where the decision lives instead.
    const res = await patch({
      settings: { PRE_PR_CHECKS_ALLOWED_ENV: ["NPM_TOKEN"] },
      reason: "widening the allowlist",
    });

    expect(res.status).toBe(400);
    expect(res.statusText).toContain("PRE_PR_CHECKS_ALLOWED_ENV");
    expect(res.statusText).toContain("read from the deployment environment");
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

  it("refuses the second of two tabs with 409 instead of overwriting the first", async () => {
    // Both tabs loaded DASHBOARD_ORG_NAME with no recorded change (version 0).
    const tabA = await patch({
      settings: { COLUMN_AI: "QA-A" },
      reason: "tab A",
      expectedVersions: { COLUMN_AI: 0 },
    });
    expect(tabA.status).toBe(200);

    state.sessionUserId = "user_owner";
    const tabB = await patch({
      settings: { COLUMN_AI: "QA-B" },
      reason: "tab B",
      expectedVersions: { COLUMN_AI: 0 },
    });
    expect(tabB.status).toBe(409);
    const body = await tabB.json();
    expect(body.error).toBe("settings_version_conflict");
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]).toMatchObject({
      key: "COLUMN_AI",
      expectedVersion: 0,
      setting: {
        key: "COLUMN_AI",
        value: "QA-A",
        source: "stored",
        lastVersion: { newValue: "QA-A", actor: "user_admin", actorLabel: "Admin" },
      },
    });
    expect(body.conflicts[0].currentVersion).toBe(body.conflicts[0].setting.lastVersion.id);

    // Nothing of tab B was written; tab A's value stands.
    expect(await db.select().from(settings)).toEqual([
      expect.objectContaining({ key: "COLUMN_AI", value: "QA-A" }),
    ]);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(1);

    // Tab B chooses to overwrite: it sends the version it has now seen.
    const overwrite = await patch({
      settings: { COLUMN_AI: "QA-B" },
      reason: "tab B, after seeing A",
      expectedVersions: { COLUMN_AI: body.conflicts[0].currentVersion },
    });
    expect(overwrite.status).toBe(200);
    expect(entry((await overwrite.json()).settings, "COLUMN_AI").value).toBe("QA-B");
  });

  it("keeps today's last-write-wins for a request that carries no version", async () => {
    await patch({ settings: { COLUMN_AI: "QA-A" }, reason: "tab A" });
    const blind = await patch({ settings: { COLUMN_AI: "QA-B" }, reason: "old client" });
    expect(blind.status).toBe(200);
    expect(entry((await blind.json()).settings, "COLUMN_AI").value).toBe("QA-B");
  });
});

describe("POST /api/v1/settings/reset", () => {
  it("removes an owner's stored value, records it, and says what took over", async () => {
    await patch({ settings: { MAX_CONCURRENT_AGENTS: 7 }, reason: "more" });
    const stored = entry((await (await get()).json()).settings, "MAX_CONCURRENT_AGENTS");

    state.sessionUserId = "user_owner";
    const res = await reset({
      key: "MAX_CONCURRENT_AGENTS",
      reason: "back to the default",
      expectedVersion: stored.lastVersion?.id,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      removed: true,
      setting: {
        key: "MAX_CONCURRENT_AGENTS",
        value: 3,
        source: "default",
        lastVersion: {
          previousValue: 7,
          newValue: 3,
          actor: "user_owner",
          actorLabel: "Owner",
          reason: "back to the default",
        },
      },
    });
    await expect(db.select().from(settings)).resolves.toHaveLength(0);
  });

  it("answers removed: false for a key with nothing stored, and records nothing", async () => {
    state.sessionUserId = "user_owner";
    const res = await reset({ key: "COLUMN_AI", reason: "tidy" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: false, setting: { source: "default" } });
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
  });

  it("refuses to remove a value somebody changed after it was read", async () => {
    await patch({ settings: { COLUMN_AI: "QA-A" }, reason: "first" });
    const seen = entry((await (await get()).json()).settings, "COLUMN_AI").lastVersion!.id;
    await patch({ settings: { COLUMN_AI: "QA-B" }, reason: "somebody else" });

    state.sessionUserId = "user_owner";
    const res = await reset({ key: "COLUMN_AI", reason: "tidy", expectedVersion: seen });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflicts[0]).toMatchObject({
      key: "COLUMN_AI",
      expectedVersion: seen,
      setting: { value: "QA-B", source: "stored" },
    });
    expect(await db.select().from(settings)).toEqual([
      expect.objectContaining({ key: "COLUMN_AI", value: "QA-B" }),
    ]);
  });

  it("follows the owner-only rule MCP settings.reset has: an admin and a member get 403", async () => {
    await patch({ settings: { COLUMN_AI: "QA-A" }, reason: "first" });
    for (const userId of ["user_admin", "user_member"]) {
      state.sessionUserId = userId;
      const res = await reset({ key: "COLUMN_AI", reason: "tidy" });
      expect(res.status).toBe(403);
    }
    await expect(db.select().from(settings)).resolves.toHaveLength(1);
  });

  it("refuses an unknown key, a missing reason, and a key the environment owns", async () => {
    state.sessionUserId = "user_owner";
    expect((await reset({ key: "NOT_A_SETTING", reason: "typo" })).status).toBe(400);
    expect((await reset({ key: "COLUMN_AI" })).status).toBe(400);
    const owned = await reset({ key: "PRE_PR_CHECKS_ALLOWED_ENV", reason: "tidy" });
    expect(owned.status).toBe(400);
    expect(owned.statusText).toContain("read from the deployment environment");
  });
});
