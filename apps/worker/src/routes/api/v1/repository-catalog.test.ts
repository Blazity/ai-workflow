import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REPOSITORY_CATALOG_NO_ENABLED_MESSAGE,
  REPOSITORY_ENABLED_NOT_A_PROFILE_FIELD,
} from "@shared/contracts";
import type { Db } from "../../../db/client.js";
import {
  activeRuns,
  member,
  organization,
  user,
  workflowOwnedBranches,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../services/auth/auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));

const catalogGet = (await import("./repository-catalog.get.js")).default;
const entryGet = (await import("./repository-catalog/[id].get.js")).default;
const entryPut = (await import("./repository-catalog/[id].put.js")).default;
const enabledPatch = (await import("./repository-catalog/[id]/enabled.patch.js")).default;
const versionsGet = (await import("./repository-catalog/[id]/versions.get.js")).default;
const activatePost = (await import("./repository-catalog/activate.post.js")).default;
const suggestionsGet = (await import("./repository-catalog/[id]/suggestions.get.js"))
  .default;
const { upsertRepositoryProfile, setRepositoryEnabled } = await import(
  "../../../db/repositories/repository-catalog.js"
);

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function paramHandler(
  method: "get" | "put" | "patch" | "post",
  pattern: string,
  route: unknown,
) {
  const app = createApp();
  const router = createRouter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router[method](pattern, route as any);
  app.use(router);
  return toWebHandler(app);
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PROFILE = {
  provider: "github",
  path: "acme/api",
  description: "The API",
  rules: "never force push",
  relationships: [],
  scriptGroups: {
    provider: "github",
    repoPath: "acme/api",
    groups: { test: { commands: ["pnpm test"] } },
  },
  gateGroups: ["test"],
  reason: "first profile",
};

const put = (id: number, body: unknown) =>
  paramHandler("put", "/api/v1/repository-catalog/:id", entryPut)(
    jsonRequest(`http://worker.test/api/v1/repository-catalog/${id}`, "PUT", body),
  );
const get = (id: number) =>
  paramHandler("get", "/api/v1/repository-catalog/:id", entryGet)(
    new Request(`http://worker.test/api/v1/repository-catalog/${id}`),
  );
const versions = (id: number, query = "") =>
  paramHandler("get", "/api/v1/repository-catalog/:id/versions", versionsGet)(
    new Request(
      `http://worker.test/api/v1/repository-catalog/${id}/versions${query}`,
    ),
  );
const setEnabled = (id: number, body: unknown) =>
  paramHandler("patch", "/api/v1/repository-catalog/:id/enabled", enabledPatch)(
    jsonRequest(
      `http://worker.test/api/v1/repository-catalog/${id}/enabled`,
      "PATCH",
      body,
    ),
  );
const suggestions = (id: number, query = "") =>
  paramHandler("get", "/api/v1/repository-catalog/:id/suggestions", suggestionsGet)(
    new Request(
      `http://worker.test/api/v1/repository-catalog/${id}/suggestions${query}`,
    ),
  );
const activate = (body: unknown) =>
  handlerFor(activatePost)(
    jsonRequest("http://worker.test/", "POST", body),
  );

async function seedProfile(path = "acme/api"): Promise<number> {
  const saved = await upsertRepositoryProfile(db, {
    provider: "github",
    path,
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: { provider: "github", repoPath: path, groups: {} },
    gateGroups: null,
    actorId: "user_admin",
    actorLabel: "Admin",
    reason: "",
  });
  return saved.id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  db = await createTestDb();
  state.db = db;
  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

describe("GET /api/v1/repository-catalog", () => {
  it("reports the bridge on a deployment that never activated", async () => {
    const res = await handlerFor(catalogGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: {
        activated: false,
        bridge: true,
        activatedAt: null,
        activatedById: null,
        activatedByLabel: null,
        activationReason: null,
      },
      repositories: [],
    });
  });

  it("lists every row, disabled ones included", async () => {
    const disabled = await seedProfile("acme/web");
    await setRepositoryEnabled(db, { id: disabled, enabled: false });
    await seedProfile("acme/api");

    const body = await (await handlerFor(catalogGet)(new Request("http://worker.test/"))).json();
    expect(body.repositories.map((entry: { path: string }) => entry.path)).toEqual([
      "acme/api",
      "acme/web",
    ]);
  });

  it("is open to a member", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(catalogGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/v1/repository-catalog/:id", () => {
  it("creates a repository and its first profile version", async () => {
    const res = await put(0, PROFILE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.repository).toMatchObject({
      provider: "github",
      path: "acme/api",
      rules: "never force push",
      source: "manual",
      // Saving a profile configures a repository; it never grants one.
      enabled: false,
      profileVersion: 1,
      checksVersion: 1,
    });
  });

  it("creates an enabled repository only when the body asks for it", async () => {
    const body = await (await put(0, { ...PROFILE, enabled: true })).json();
    expect(body.repository.enabled).toBe(true);
  });

  it("leaves the checks version alone when only the prose changes", async () => {
    const created = await (await put(0, PROFILE)).json();
    const again = await (
      await put(created.repository.id, { ...PROFILE, description: "Now with words" })
    ).json();
    expect(again.version).toBe(2);
    expect(again.repository.checksVersion).toBe(1);
  });

  // D11. `enabled` on an existing repository used to be accepted and silently
  // discarded, which on the wire is indistinguishable from a grant that landed.
  // The row is unchanged either way; the difference is that the caller is now
  // told, and told which switch to use instead. Refused only when the value
  // would MOVE the switch: see the test below this one.
  it("refuses an enabled that would move the switch, and says which switch to use", async () => {
    const created = await (await put(0, { ...PROFILE, enabled: true })).json();

    const refused = await put(created.repository.id, { ...PROFILE, enabled: false });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(REPOSITORY_ENABLED_NOT_A_PROFILE_FIELD);
    const after = await (await get(created.repository.id)).json();
    expect(after.repository.enabled).toBe(true);
  });

  // The other half of D11 as the gate settled it: callers were told for a long
  // time that this field was ignored here, so a body that repeats where the
  // switch already stands asks for no change and is not refused for one.
  it("accepts an enabled that repeats where the switch already stands", async () => {
    const created = await (await put(0, { ...PROFILE, enabled: true })).json();

    const repeated = await put(created.repository.id, {
      ...PROFILE,
      description: "second save",
      enabled: true,
    });

    expect(repeated.status).toBe(200);
    const after = await (await get(created.repository.id)).json();
    expect(after.repository.enabled).toBe(true);
    expect(after.currentProfile.description).toBe("second save");
  });

  // The same rule on the path the dashboard takes for a create: id 0, but a
  // provider and path the catalog already holds.
  it("refuses enabled on a create the catalog reconciles into an edit", async () => {
    await (await put(0, PROFILE)).json();

    const refused = await put(0, { ...PROFILE, enabled: true });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(REPOSITORY_ENABLED_NOT_A_PROFILE_FIELD);

    // A new row defaults to disabled, so `enabled: false` on that same
    // reconciled create asks for nothing and lands.
    expect((await put(0, { ...PROFILE, enabled: false })).status).toBe(200);
  });

  // D3 / row P24. Permissive save, loud response: the documented uv preset is a
  // remote-execution command somebody means to run, so the surface warns rather
  // than refuses, and the warning names the group and the command.
  it("warns about a command that downloads and runs remote code, and saves it anyway", async () => {
    const res = await put(0, {
      ...PROFILE,
      scriptGroups: {
        provider: "github",
        repoPath: "acme/api",
        setup: ["curl -LsSf https://astral.sh/uv/install.sh | sh"],
        groups: { test: { commands: ["pnpm test"] } },
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toEqual([
      {
        group: "setup",
        command: "curl -LsSf https://astral.sh/uv/install.sh | sh",
        kind: "remote_execution",
      },
    ]);
    expect(body.repository.path).toBe("acme/api");
  });

  it("warns about nothing when every command is local", async () => {
    const body = await (await put(0, PROFILE)).json();
    expect(body.warnings).toEqual([]);
  });

  // D4 / row P31. The audit line is the whole point of a profile version, and
  // HTTP used to default it to the empty string while MCP required it.
  it("refuses a profile save with no reason, so the version history is never blank", async () => {
    const { reason: _reason, ...withoutReason } = PROFILE;
    expect((await put(0, withoutReason)).status).toBe(400);
    expect((await put(0, { ...PROFILE, reason: "   " })).status).toBe(400);
    const body = await (await handlerFor(catalogGet)(new Request("http://worker.test/"))).json();
    expect(body.repositories).toEqual([]);
  });

  // D12 / rows P29, P30.
  it("refuses a profile that relates a repository to itself", async () => {
    const id = await seedProfile("acme/api");

    const refused = await put(id, {
      ...PROFILE,
      relationships: [{ repositoryId: id, label: "shares the schema" }],
    });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("relationship_self_reference");
  });

  it("refuses the same repository related twice", async () => {
    const other = await seedProfile("acme/web");

    const refused = await put(0, {
      ...PROFILE,
      relationships: [
        { repositoryId: other, label: "shares the schema" },
        { repositoryId: other, label: "and the client" },
      ],
    });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("related twice");
  });

  // Deliberately still accepted: the row a relationship names may be imported
  // later, and the Overview tab renders an id it cannot resolve as a plain
  // `repository <id>` rather than crashing.
  it("accepts a relationship to a repository the catalog does not hold yet", async () => {
    const res = await put(0, {
      ...PROFILE,
      relationships: [{ repositoryId: 4242, label: "imported next week" }],
    });
    expect(res.status).toBe(200);
    const stored = await (await get((await res.json()).repository.id)).json();
    expect(stored.currentProfile.relationships).toEqual([
      { repositoryId: 4242, label: "imported next week" },
    ]);
  });

  it("mints the next version when the same repository is saved again", async () => {
    const created = await (await put(0, PROFILE)).json();
    const again = await (
      await put(created.repository.id, { ...PROFILE, rules: "and rebase" })
    ).json();
    expect(again.version).toBe(2);
    expect(again.repository.rules).toBe("and rebase");
  });

  it("refuses a route id that names a different repository", async () => {
    const other = await seedProfile("acme/web");
    const res = await put(other, PROFILE);
    expect(res.status).toBe(409);
  });

  it("refuses a body the contract does not accept", async () => {
    const res = await put(0, { ...PROFILE, path: "api" });
    expect(res.status).toBe(400);
  });

  it("refuses a group name the checks engine could never resolve", async () => {
    const res = await put(0, {
      ...PROFILE,
      scriptGroups: {
        provider: "github",
        repoPath: "acme/api",
        groups: { "Unit Tests": { commands: ["pnpm test"] } },
      },
      gateGroups: null,
    });

    expect(res.status).toBe(400);
    // Refused rather than repaired: "Unit Tests" could have meant `unit-tests`
    // or `test`, and a profile that saves and then cannot be parsed is a
    // repository whose checks silently never run.
    const body = await (await handlerFor(catalogGet)(new Request("http://worker.test/"))).json();
    expect(body.repositories).toEqual([]);
  });

  it("gives a member 403 and writes nothing", async () => {
    state.sessionUserId = "user_member";
    const res = await put(0, PROFILE);
    expect(res.status).toBe(403);
    const body = await (await handlerFor(catalogGet)(new Request("http://worker.test/"))).json();
    expect(body.repositories).toEqual([]);
  });
});

describe("GET /api/v1/repository-catalog/:id", () => {
  it("returns the repository and the profile it currently resolves to", async () => {
    const id = await seedProfile();
    const body = await (await get(id)).json();
    expect(body.repository).toMatchObject({ id, path: "acme/api" });
    expect(body.currentProfile).toMatchObject({ version: 1, actorLabel: "Admin" });
  });

  it("is 404 for a repository that does not exist", async () => {
    expect((await get(9999)).status).toBe(404);
  });

  it("is open to a member", async () => {
    const id = await seedProfile();
    state.sessionUserId = "user_member";
    expect((await get(id)).status).toBe(200);
  });
});

describe("GET /api/v1/repository-catalog/:id/versions", () => {
  it("lists the profile history newest first, and is open to a member", async () => {
    const id = await seedProfile();
    await put(id, PROFILE);
    state.sessionUserId = "user_member";
    const body = await (await versions(id)).json();
    expect(body.versions.map((entry: { version: number }) => entry.version)).toEqual([2, 1]);
    // Nothing older than version 1, and the tab needs to know that to stop
    // offering "Load more".
    expect(body.hasMore).toBe(false);
  });

  // D5 / row P34. The same paging the MCP history tool answers with: a page
  // size, a `before` cursor that is a version number, and `hasMore`.
  it("pages the history by version, oldest excluded, and says when more is left", async () => {
    const id = await seedProfile();
    await put(id, { ...PROFILE, rules: "two", reason: "two" });
    await put(id, { ...PROFILE, rules: "three", reason: "three" });
    await put(id, { ...PROFILE, rules: "four", reason: "four" });

    const first = await (await versions(id, "?limit=2")).json();
    expect(first.versions.map((entry: { version: number }) => entry.version)).toEqual([4, 3]);
    expect(first.hasMore).toBe(true);

    const second = await (await versions(id, "?limit=2&before=3")).json();
    expect(second.versions.map((entry: { version: number }) => entry.version)).toEqual([2, 1]);
    expect(second.hasMore).toBe(false);
  });

  it("refuses a page size nobody could mean rather than answering a different one", async () => {
    const id = await seedProfile();
    expect((await versions(id, "?limit=0")).status).toBe(400);
    expect((await versions(id, "?limit=201")).status).toBe(400);
    expect((await versions(id, "?before=nope")).status).toBe(400);
  });
});

describe("PATCH /api/v1/repository-catalog/:id/enabled", () => {
  it("switches a repository off without minting a profile version", async () => {
    const id = await seedProfile();
    const res = await setEnabled(id, { enabled: false });
    expect(res.status).toBe(200);
    expect((await res.json()).repository).toMatchObject({
      enabled: false,
      profileVersion: 1,
    });
    const history = await (await versions(id)).json();
    expect(history.versions).toHaveLength(1);
  });

  // Stage D1 answered an enable with a warning whenever the engine's allowlist
  // variable omitted the repository: enabling a row was not enough on its own.
  // The engine now reads the catalog itself, so enabling IS enough and the
  // response carries the row and nothing else.
  it("answers an enable with the row and how many are left enabled, with no transitional warning", async () => {
    const id = await seedProfile("acme/api");
    await setEnabled(id, { enabled: false });

    const res = await setEnabled(id, { enabled: true });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repository).toMatchObject({ enabled: true });
    expect(body).not.toHaveProperty("warnings");
    expect(Object.keys(body).sort()).toEqual(["enabledRemaining", "repository"]);
  });

  // D2 / row L25. The number HTTP answers with is the number MCP already
  // answered with, and it is what the list screen shows its zero-enabled
  // warning off: the switch that turned the last one off is the only place the
  // screen learns it was the last one.
  it("counts what is left enabled, so the list can warn when the last switch goes off", async () => {
    const first = await seedProfile("acme/api");
    const second = await seedProfile("acme/web");
    await setEnabled(first, { enabled: true });
    await setEnabled(second, { enabled: true });

    const afterOne = await (await setEnabled(second, { enabled: false })).json();
    expect(afterOne.enabledRemaining).toBe(1);

    const afterBoth = await (await setEnabled(first, { enabled: false })).json();
    expect(afterBoth.enabledRemaining).toBe(0);
  });

  it("refuses a non-boolean", async () => {
    const id = await seedProfile();
    expect((await setEnabled(id, { enabled: "false" })).status).toBe(400);
  });

  it("gives a member 403", async () => {
    const id = await seedProfile();
    state.sessionUserId = "user_member";
    expect((await setEnabled(id, { enabled: false })).status).toBe(403);
  });
});

describe("POST /api/v1/repository-catalog/activate", () => {
  // Every activation below needs one enabled row, because the service refuses
  // an activation that would leave dispatch with nothing to select. The
  // refusal itself is the test right after this helper.
  async function seedEnabled(path = "acme/enabled"): Promise<number> {
    const id = await seedProfile(path);
    await setRepositoryEnabled(db, { id, enabled: true });
    return id;
  }

  // D1 / row L18. The sentence used to be typed out in the dashboard dialog and
  // again in the MCP tool, with the service both go through checking neither,
  // so an activation that reached this route directly went through and left
  // dispatch with nothing to select.
  it("refuses to activate a catalog that enables nothing, with a code the screen can branch on", async () => {
    await seedProfile("acme/api");

    const refused = await activate({
      acknowledgedRepositoryKeys: [],
      reason: "the bridge is over",
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "no_enabled_repository",
      message: REPOSITORY_CATALOG_NO_ENABLED_MESSAGE,
    });
    const body = await (await handlerFor(catalogGet)(new Request("http://worker.test/"))).json();
    expect(body.state.bridge).toBe(true);
  });

  it("activates when nothing is in flight", async () => {
    await seedEnabled();
    const res = await activate({ acknowledgedRepositoryKeys: [], reason: "the bridge is over" });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toMatchObject({
      activated: true,
      bridge: false,
      activationReason: "the bridge is over",
    });
  });

  it("refuses an activation with no reason, so the audit line is never empty", async () => {
    await seedEnabled();
    const res = await activate({ acknowledgedRepositoryKeys: [], reason: "  " });
    expect(res.status).toBe(400);
  });

  it("refuses with the list when a live claim works in a repository that is not enabled", async () => {
    await seedEnabled();
    const id = await seedProfile("acme/web");
    await setRepositoryEnabled(db, { id, enabled: false });
    await db.insert(activeRuns).values({
      subjectKey: "jira:AIW-1",
      ticketKey: "AIW-1",
      ownerToken: "token-1",
      runId: "run-1",
      state: "bound",
    });
    await db.insert(workflowOwnedBranches).values({
      ticketKey: "AIW-1",
      provider: "github",
      repoPath: "acme/web",
      branchName: "ai/AIW-1",
    });

    const refused = await activate({ acknowledgedRepositoryKeys: [], reason: "the bridge is over" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "unacknowledged_repositories",
      repositories: [
        {
          key: "github:acme/web",
          displayName: "acme/web",
          ticketKeys: ["AIW-1"],
          runIds: ["run-1"],
        },
      ],
    });

    const accepted = await activate({
      acknowledgedRepositoryKeys: ["github:acme/web"],
      reason: "the bridge is over",
    });
    expect(accepted.status).toBe(200);
  });

  it("gives a member 403 and leaves the bridge up", async () => {
    await seedEnabled();
    state.sessionUserId = "user_member";
    expect((await activate({ acknowledgedRepositoryKeys: [], reason: "the bridge is over" })).status).toBe(403);
    const body = await (await handlerFor(catalogGet)(new Request("http://worker.test/"))).json();
    expect(body.state.bridge).toBe(true);
  });
});

describe("PUT /api/v1/repository-catalog/:id as a patch", () => {
  it("leaves an omitted field alone and names only what moved", async () => {
    const id = await seedProfile();
    const stored = await get(id);
    const before = (await stored.json()).currentProfile;

    const res = await put(id, {
      provider: "github",
      path: "acme/api",
      rules: "never force push",
      reason: "rules only",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changedFields).toEqual(["rules"]);
    expect(body.unchanged).toBe(false);
    const after = (await (await get(id)).json()).currentProfile;
    expect(after.scriptGroups).toEqual(before.scriptGroups);
    expect(after.rules).toBe("never force push");
  });

  it("mints nothing and says so when the request changes nothing", async () => {
    const id = await seedProfile();
    const res = await put(id, {
      provider: "github",
      path: "acme/api",
      rules: "",
      reason: "clicked twice",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unchanged).toBe(true);
    expect(body.changedFields).toEqual([]);
    expect((await (await versions(id)).json()).versions).toHaveLength(1);
  });

  it("answers 409 with the version the profile actually sits at", async () => {
    const id = await seedProfile();
    await put(id, {
      provider: "github",
      path: "acme/api",
      rules: "somebody else got here first",
      reason: "their edit",
    });

    const refused = await put(id, {
      provider: "github",
      path: "acme/api",
      rules: "built on a stale baseline",
      expectedProfileVersion: 1,
      reason: "my edit",
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "repository_profile_conflict",
      currentVersion: 2,
    });
    // Refused, not merged: the other edit is still what is stored.
    const after = (await (await get(id)).json()).currentProfile;
    expect(after.rules).toBe("somebody else got here first");
    expect(after.version).toBe(2);
  });

  it("takes the token when the profile has not moved", async () => {
    const id = await seedProfile();
    const res = await put(id, {
      provider: "github",
      path: "acme/api",
      rules: "still current",
      expectedProfileVersion: 1,
      reason: "my edit",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(2);
  });
});

describe("GET /api/v1/repository-catalog/:id/suggestions", () => {
  it("lists the calls newest first, unpriced when the provider reported nothing", async () => {
    const id = await seedProfile();
    const { insertRepositorySuggestion } = await import(
      "../../../db/repositories/repository-suggestions.js"
    );
    await insertRepositorySuggestion(db, {
      repositoryId: id,
      actorId: "user_admin",
      actorLabel: "Admin",
      model: "claude-sonnet",
      outcome: "proposed",
      usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20 },
      durationMs: 1500,
    });
    await insertRepositorySuggestion(db, {
      repositoryId: id,
      actorId: "user_admin",
      actorLabel: "Admin",
      model: "claude-sonnet",
      outcome: "timeout",
      usage: null,
    });

    const res = await suggestions(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBe(null);
    expect(body.suggestions.map((row: { outcome: string }) => row.outcome)).toEqual([
      "timeout",
      "proposed",
    ]);
    // A timeout reported no usage. Unpriced, never zero: zero would say the
    // call was free.
    expect(body.suggestions[0]).toMatchObject({
      priced: false,
      tokensInput: null,
      tokensOutput: null,
      durationMs: null,
    });
    expect(body.suggestions[1]).toMatchObject({
      priced: true,
      tokensInput: 100,
      tokensOutput: 20,
      durationMs: 1500,
    });
  });

  it("refuses a cursor nobody issued rather than answering somebody else's page", async () => {
    const id = await seedProfile();
    expect((await suggestions(id, "?cursor=not-a-cursor")).status).toBe(400);
  });

  it("is open to a member, because a cost history is a read", async () => {
    const id = await seedProfile();
    state.sessionUserId = "user_member";
    expect((await suggestions(id)).status).toBe(200);
  });
});
