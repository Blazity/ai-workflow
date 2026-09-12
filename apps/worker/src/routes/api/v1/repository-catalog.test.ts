import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const versions = (id: number) =>
  paramHandler("get", "/api/v1/repository-catalog/:id/versions", versionsGet)(
    new Request(`http://worker.test/api/v1/repository-catalog/${id}/versions`),
  );
const setEnabled = (id: number, body: unknown) =>
  paramHandler("patch", "/api/v1/repository-catalog/:id/enabled", enabledPatch)(
    jsonRequest(
      `http://worker.test/api/v1/repository-catalog/${id}/enabled`,
      "PATCH",
      body,
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

  it("never revokes a grant somebody made", async () => {
    const created = await (await put(0, { ...PROFILE, enabled: true })).json();
    const again = await (
      await put(created.repository.id, { ...PROFILE, enabled: false })
    ).json();
    expect(again.repository.enabled).toBe(true);
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

  // Enabling a row the engine's allowlist variable still omits buys a run that
  // starts and then fails at promotion or pull request creation, which costs an
  // agent invocation before it says no. Until stage X removes that variable, the
  // operator hears about it at the moment they flip the switch.
  it("warns when the engine allowlist does not carry a repository being enabled", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/other";
    try {
      const id = await seedProfile("acme/api");
      await setEnabled(id, { enabled: false });

      const res = await setEnabled(id, { enabled: true });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.repository).toMatchObject({ enabled: true });
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toContain("AGENT_ALLOWED_REPOS");
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("says nothing when the variable carries it, and nothing on a disable", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "Acme/API";
    try {
      const id = await seedProfile("acme/api");
      await setEnabled(id, { enabled: false });

      // On the allowlist, case-insensitively, exactly as the run will read it.
      expect(await (await setEnabled(id, { enabled: true })).json()).not.toHaveProperty(
        "warnings",
      );
      // A disable starts nothing, so there is nothing to warn about.
      process.env.AGENT_ALLOWED_REPOS = "acme/other";
      expect(await (await setEnabled(id, { enabled: false })).json()).not.toHaveProperty(
        "warnings",
      );
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
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
  it("activates when nothing is in flight", async () => {
    const res = await activate({ acknowledgedRepositoryKeys: [] });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toMatchObject({ activated: true, bridge: false });
  });

  it("refuses with the list when a live claim works in a repository that is not enabled", async () => {
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

    const refused = await activate({ acknowledgedRepositoryKeys: [] });
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
    });
    expect(accepted.status).toBe(200);
  });

  it("gives a member 403 and leaves the bridge up", async () => {
    state.sessionUserId = "user_member";
    expect((await activate({ acknowledgedRepositoryKeys: [] })).status).toBe(403);
    const body = await (await handlerFor(catalogGet)(new Request("http://worker.test/"))).json();
    expect(body.state.bridge).toBe(true);
  });
});
