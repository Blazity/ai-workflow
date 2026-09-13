/**
 * Repository catalog HTTP rows the QA matrix found unpinned (epic AIW-338).
 *
 * A companion to `repository-catalog.test.ts`, not a replacement: that suite
 * says what the routes are FOR, and this one pins the corners the matrix walked
 * into and found nothing asserting them. Each test name carries its matrix row
 * id, so a failure here can be read back against
 * `docs/qa/repository-catalog-matrix.md` without guessing which behaviour moved.
 *
 * Three of these rows turned out DIFFERENT from what the matrix expected, and
 * they are pinned as the code behaves rather than as the matrix hoped (P22,
 * P23, and the reach of T01). Where that is so, the test says what the matrix
 * claimed and what is actually true, so deciding to change the behaviour later
 * means editing an assertion somebody has to read first.
 *
 * The mock block below is not shared with the sibling suite because `vi.mock`
 * is hoisted per file and cannot be: every helper this file could import it
 * does import (`createTestDb`, the schema, the route handlers, the repository
 * tier), and what is restated is the request plumbing alone.
 */
import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import {
  member,
  organization,
  repositoryCatalogState,
  settings,
  settingsVersions,
  user,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
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
const versionsGet = (await import("./repository-catalog/[id]/versions.get.js")).default;
const activatePost = (await import("./repository-catalog/activate.post.js")).default;
const settingsPatch = (await import("./settings.patch.js")).default;
const { getCurrentCheckConfiguration, setRepositoryEnabled } = await import(
  "../../../db/repositories/repository-catalog.js"
);
const { repoScriptsConfigSchema } = await import(
  "../../../engine/pre-pr-checks/config.js"
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

/** `PUT /api/v1/repository-catalog/:id`, with the id spelt as the caller sent
 *  it: a string, because one of these rows is about a segment that is not a
 *  number at all. */
const put = (id: number | string, body: unknown) =>
  paramHandler("put", "/api/v1/repository-catalog/:id", entryPut)(
    jsonRequest(`http://worker.test/api/v1/repository-catalog/${id}`, "PUT", body),
  );
const get = (id: number | string) =>
  paramHandler("get", "/api/v1/repository-catalog/:id", entryGet)(
    new Request(`http://worker.test/api/v1/repository-catalog/${id}`),
  );
const versions = (id: number | string) =>
  paramHandler("get", "/api/v1/repository-catalog/:id/versions", versionsGet)(
    new Request(`http://worker.test/api/v1/repository-catalog/${id}/versions`),
  );
const activate = (body: unknown) =>
  handlerFor(activatePost)(jsonRequest("http://worker.test/", "POST", body));
const patchSettings = (body: unknown) =>
  handlerFor(settingsPatch)(jsonRequest("http://worker.test/", "PATCH", body));
const catalog = () => handlerFor(catalogGet)(new Request("http://worker.test/"));

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
  reason: "first profile",
};

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
    { id: "user_owner", name: "Owner", email: "owner@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "member_owner", organizationId: "org_aiw", userId: "user_owner", role: "owner" },
  ]);
});

describe("POST /api/v1/repository-catalog/activate, a second time", () => {
  it("L19: re-activation keeps the row and replaces everything on it", async () => {
    // D1 / row L18 refuses an activation on a catalog that enables nothing, so
    // this row needs one repository switched on before either call. Created the
    // way every other row here creates one (the PUT route), then enabled at the
    // repository tier, which is the same seam the sibling suite's `seedEnabled`
    // uses: the switch is not a profile field, so a profile write cannot set it.
    const seeded = await (await put(0, PROFILE)).json();
    await setRepositoryEnabled(db, { id: seeded.repository.id, enabled: true });

    const first = await activate({
      acknowledgedRepositoryKeys: [],
      reason: "the bridge is over",
    });
    expect(first.status).toBe(200);
    const before = (await first.json()).state;

    state.sessionUserId = "user_owner";
    const second = await activate({
      acknowledgedRepositoryKeys: [],
      reason: "re-read it and meant it",
    });

    expect(second.status).toBe(200);
    const after = (await second.json()).state;
    // Still activated, so the surface reports a no-op correctly...
    expect(after.activated).toBe(true);
    expect(after.bridge).toBe(false);
    // ...but every attributable field on the state row was overwritten by the
    // second call. There is no append: `activateRepositoryCatalog` is one
    // `onConflictDoUpdate` on the singleton row
    // (db/repositories/repository-catalog.ts, "One statement, so a second click
    // cannot create a second state row"), so the first activation's actor,
    // timestamp and reason are gone rather than superseded.
    expect(after.activationReason).toBe("re-read it and meant it");
    expect(after.activatedByLabel).toBe("Owner");
    expect(before.activationReason).toBe("the bridge is over");
    expect(before.activatedByLabel).toBe("Admin");

    // One row, and it is the only record of activation this deployment has.
    // Open question O10 in the matrix is the proposal to append instead; until
    // it is decided, this is the behaviour and losing it silently is the risk.
    const rows = await db.select().from(repositoryCatalogState);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      activated: true,
      activatedById: "user_owner",
      activationReason: "re-read it and meant it",
    });
  });
});

describe("PUT /api/v1/repository-catalog/:id, identity through the body", () => {
  it("P11: repositoryId 0 onto a path the catalog holds edits that row rather than adding a second", async () => {
    const created = await (await put(0, PROFILE)).json();
    expect(created.version).toBe(1);

    // The dashboard entry screen sends 0 for "a repository the catalog has
    // never seen". A screen that loaded before the row existed, or a script
    // that always sends 0, therefore arrives at a path that IS held. Identity
    // is the provider and path on the body, and `saveRepositoryProfile` skips
    // its mismatch check precisely when the expected id is 0
    // (services/repository-catalog/authoring.ts), so this reconciles.
    const again = await put(0, { ...PROFILE, rules: "and rebase", reason: "second pass" });

    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body.repository.id).toBe(created.repository.id);
    expect(body.version).toBe(2);
    expect(body.changedFields).toEqual(["rules"]);

    const list = await (await catalog()).json();
    expect(list.repositories).toHaveLength(1);
    expect((await (await versions(created.repository.id)).json()).versions).toHaveLength(2);
  });

  it("P15: a route id that is not a number is 404, not 400", async () => {
    // Deliberate, and documented on `repositoryIdFrom`: the client asked for a
    // repository that cannot exist, and answering "bad request" would send
    // whoever reads the log looking at the body instead of the URL.
    expect((await get("abc")).status).toBe(404);
    expect((await versions("abc")).status).toBe(404);
    expect((await get("1e3")).status).toBe(404);
    // The PUT segment admits 0 as "new" and refuses the rest the same way.
    expect((await put("abc", PROFILE)).status).toBe(404);
    expect((await put(-1, PROFILE)).status).toBe(404);
  });
});

describe("PUT /api/v1/repository-catalog/:id, gateGroups", () => {
  // MATRIX CORRECTION. The matrix expected both of these refused at the profile
  // route (rows P22 and P23, "Validation error, not 'none'"). They are not.
  // `repositoryCatalogUpsertRequestSchema` types gateGroups as
  // `z.array(z.string()).nullable().optional()` with no bound and no
  // cross-reference check (packages/contracts/repository-catalog-api.ts), and
  // `saveRepositoryProfile` validates group NAMES only. The contract says so
  // out loud on `repositoryProfileVersionSchema`: "an empty array is refused by
  // the scripts schema, not here."
  //
  // So the refusal exists, one tier further down, and these tests pin both
  // halves: the route stores it, and the engine's own schema is what refuses
  // the composed configuration. That is a run-time failure on a repository
  // whose profile saved cleanly, which is the cost of the seam and the reason
  // the row is worth an assertion at all.

  it("P22: an empty gateGroups array saves, and the engine schema is what refuses it", async () => {
    const res = await put(0, { ...PROFILE, gateGroups: [] });

    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.changedFields).toContain("gateGroups");
    const stored = (await (await get(saved.repository.id)).json()).currentProfile;
    expect(stored.gateGroups).toEqual([]);

    const composed = await getCurrentCheckConfiguration(db, {
      repositoryKeys: ["github:acme/api"],
    });
    // `[]` is not nullish, so it survives composition as an authored value
    // rather than collapsing into "every group".
    expect(composed.config.repositories[0]).toMatchObject({ gateGroups: [] });
    const parsed = repoScriptsConfigSchema.safeParse(composed.config);
    expect(parsed.success).toBe(false);
    // Why the engine refuses it rather than treating it as "none": an empty
    // gate list would run zero groups and pass every run forever, ok true and
    // nothing verified (engine/pre-pr-checks/config.ts).
    expect(JSON.stringify(parsed.error?.issues)).toContain("gateGroups");
  });

  it("P23: a gateGroups reference no group answers saves, and is named only by the engine", async () => {
    const res = await put(0, { ...PROFILE, gateGroups: ["verify"] });

    expect(res.status).toBe(200);
    const saved = await res.json();
    const stored = (await (await get(saved.repository.id)).json()).currentProfile;
    // The profile declares `test` and gates on `verify`, which does not exist.
    expect(stored.scriptGroups.groups).toHaveProperty("test");
    expect(stored.gateGroups).toEqual(["verify"]);

    const composed = await getCurrentCheckConfiguration(db, {
      repositoryKeys: ["github:acme/api"],
    });
    const parsed = repoScriptsConfigSchema.safeParse(composed.config);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      'unknown group referenced in gateGroups: \\"verify\\"',
    );
  });
});

describe("PATCH /api/v1/settings against the catalog", () => {
  it("T01: the repositories group is refused on the settings patch and the catalog state row is untouched", async () => {
    // The settings suite already pins the 400 and that no settings row is
    // written (routes/api/v1/settings.test.ts, "refuses the repository catalog
    // switch"). What it cannot see from there is the other side of the seam:
    // `catalog.activated` is a registry KEY, and activation is a row in a
    // different table entirely. This asserts the refusal leaves that table
    // alone, so a future implementation that wired the key through to the
    // catalog would fail here rather than pass the settings suite.
    const res = await patchSettings({
      settings: { "catalog.activated": true },
      reason: "skipping the dialog",
    });

    expect(res.status).toBe(400);
    expect(res.statusText).toContain("catalog.activated");
    expect(res.statusText).toContain("/api/v1/repository-catalog/activate");
    await expect(db.select().from(settings)).resolves.toHaveLength(0);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(0);
    await expect(db.select().from(repositoryCatalogState)).resolves.toHaveLength(0);
    expect((await (await catalog()).json()).state).toMatchObject({
      activated: false,
      bridge: true,
    });

    // And the route that IS allowed to move it still does, so the refusal is
    // about the surface rather than about the value. Enabling one repository
    // first, because D1 / row L18 refuses an activation that would leave
    // dispatch with nothing to select; that refusal is 409 and belongs to the
    // activate route, which would otherwise hide the 200 this row is about.
    const seeded = await (await put(0, PROFILE)).json();
    await setRepositoryEnabled(db, { id: seeded.repository.id, enabled: true });
    expect(
      (await activate({ acknowledgedRepositoryKeys: [], reason: "through the dialog" }))
        .status,
    ).toBe(200);
    expect((await (await catalog()).json()).state.bridge).toBe(false);
  });
});
