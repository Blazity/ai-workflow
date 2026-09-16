import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import {
  member,
  organization,
  repositories,
  repositoryCatalogState,
  user,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_member" as string | null,
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

const workScopeGet = (await import("./work-scope.get.js")).default;
const workScopePatch = (await import("./work-scope.patch.js")).default;

const SUBJECT = "ticket:jira:AIW-401";
const API = "github:acme/api";
const WEB = "github:acme/web";
const OFFERED = "github:acme/offered";

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function get(query = ""): Promise<Response> {
  return handlerFor(workScopeGet)(new Request(`http://worker.test/${query}`));
}

function patch(body: unknown): Promise<Response> {
  return handlerFor(workScopePatch)(
    new Request("http://worker.test/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_member";
  db = await createTestDb();
  state.db = db;
  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values({
    id: "user_member",
    name: "Ada Lovelace",
    email: "ada@example.com",
    emailVerified: true,
  });
  await db.insert(member).values({
    id: "member_member",
    organizationId: "org_aiw",
    userId: "user_member",
    role: "member",
  });
  await db
    .insert(user)
    .values({ id: "user_outsider", name: "Outsider", email: "out@example.com", emailVerified: true });
  await db.insert(repositoryCatalogState).values({ id: 1, activated: true });
  await db
    .insert(repositories)
    .values({ provider: "github", path: "acme/api", source: "manual", enabled: true });
  await db
    .insert(repositories)
    .values({ provider: "github", path: "acme/web", source: "manual", enabled: true });
  await db
    .insert(repositories)
    .values({ provider: "github", path: "acme/offered", source: "manual", enabled: false });
});

describe("PATCH /api/v1/work-scope", () => {
  it("lets a member edit, because a member may answer the question that recorded the exclusion", async () => {
    const res = await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select", rationale: "the fix lives here" }],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toMatchObject({
      subjectKey: SUBJECT,
      version: 1,
      entries: [
        {
          repositoryKey: API,
          state: "selected",
          origin: "person",
          decidedBy: { kind: "person", actorId: "user_member", actorLabel: "Ada Lovelace" },
        },
      ],
    });
    // The record and nothing else, for the reason the route comment gives: what
    // this path cannot check is true of every edit it accepts, so it is said in
    // the documentation rather than repeated in every reply.
    expect(Object.keys(body as Record<string, unknown>)).toEqual(["scope"]);
  });

  it("takes an exclusion back", async () => {
    await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: WEB, action: "exclude" }],
    });

    const res = await patch({
      subjectKey: SUBJECT,
      expectedVersion: 1,
      changes: [{ repositoryKey: WEB, action: "remove" }],
    });

    expect(res.status).toBe(200);
    expect((await res.json()).scope.entries).toEqual([]);
  });

  it("answers a stale expected version with 409 and the version to read again", async () => {
    await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select" }],
    });

    const res = await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: WEB, action: "select" }],
    });

    expect(res.status).toBe(409);
    // The name every other conflicting write on this API answers with.
    expect(await res.json()).toEqual({ error: "version_conflict", latestVersion: 1 });
  });

  it("refuses a version past what the column can hold, rather than letting the driver overflow", async () => {
    const res = await patch({
      subjectKey: SUBJECT,
      expectedVersion: 2_147_483_648,
      changes: [{ repositoryKey: API, action: "select" }],
    });

    expect(res.status).toBe(400);
  });

  it("refuses the whole edit when a select names a repository the catalog does not enable", async () => {
    const res = await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [
        { repositoryKey: API, action: "select" },
        { repositoryKey: OFFERED, action: "select" },
      ],
    });

    expect(res.status).toBe(400);
    const message = (await res.json()).statusMessage;
    expect(message).toContain(OFFERED);
    // The way on, because a plain member cannot enable a repository themselves
    // and a refusal with no next action is where this whole path started.
    expect(message).toContain("Ask an owner or an admin to enable it on the Repositories page");
    const record = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}`);
    expect((await record.json()).entries).toEqual([]);
  });

  it("refuses a subject that carries no record", async () => {
    const res = await patch({
      subjectKey: "schedule:sch_1:1757980800000",
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select" }],
    });

    expect(res.status).toBe(400);
  });

  it("writes the trimmed subject key, so it cannot write a record the other surface can never address", async () => {
    const res = await patch({
      subjectKey: `  ${SUBJECT}  `,
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select" }],
    });

    expect(res.status).toBe(200);
    const record = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}`);
    expect((await record.json()).version).toBe(1);
  });

  it("refuses a body the contract does not accept", async () => {
    const res = await patch({ subjectKey: SUBJECT, expectedVersion: 0, changes: [] });

    expect(res.status).toBe(400);
  });

  it("refuses a caller with no session", async () => {
    state.sessionUserId = null;

    const res = await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select" }],
    });

    expect(res.status).toBe(401);
  });

  it("refuses a signed in user who is not in the organization", async () => {
    state.sessionUserId = "user_outsider";

    const res = await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select" }],
    });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/work-scope", () => {
  it("answers the entries and the trail behind them together", async () => {
    await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select", rationale: "the fix lives here" }],
    });

    const res = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      subjectKey: SUBJECT,
      version: 1,
      entries: [{ repositoryKey: API, state: "selected" }],
      nextTrailBeforeId: null,
    });
    expect(body.trail).toHaveLength(1);
    expect(body.trail[0].event).toMatchObject({
      kind: "entry_written",
      entry: { repositoryKey: API },
    });
  });

  it("answers a subject with no record with the version an edit must expect", async () => {
    const res = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subjectKey: SUBJECT,
      carriesRecord: true,
      version: 0,
      entries: [],
      trail: [],
      nextTrailBeforeId: null,
    });
  });

  it("pages the trail", async () => {
    await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select" }],
    });
    await patch({
      subjectKey: SUBJECT,
      expectedVersion: 1,
      changes: [{ repositoryKey: WEB, action: "select" }],
    });

    const first = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}&trailLimit=1`);
    const firstBody = await first.json();
    expect(firstBody.trail).toHaveLength(1);
    expect(firstBody.nextTrailBeforeId).not.toBeNull();

    const second = await get(
      `?subjectKey=${encodeURIComponent(SUBJECT)}&trailLimit=1&trailBefore=${firstBody.nextTrailBeforeId}`,
    );
    const secondBody = await second.json();
    expect(secondBody.trail[0].event.entry.repositoryKey).toBe(API);
  });

  it("refuses a read with no subject", async () => {
    const res = await get();

    expect(res.status).toBe(400);
  });

  it("refuses a trail page past the ceiling", async () => {
    const res = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}&trailLimit=201`);

    expect(res.status).toBe(400);
  });

  it("refuses a trail id past what the column can hold, rather than letting the driver overflow", async () => {
    const res = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}&trailBefore=2147483648`);

    expect(res.status).toBe(400);
  });

  it("answers a subject kind that keeps no record, rather than refusing a fair question", async () => {
    const res = await get(`?subjectKey=${encodeURIComponent("schedule:sch_1:1757980800000")}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      subjectKey: "schedule:sch_1:1757980800000",
      carriesRecord: false,
      version: 0,
      entries: [],
    });
    // And the write is still refused, which is where the fact belongs.
    const write = await patch({
      subjectKey: "schedule:sch_1:1757980800000",
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select" }],
    });
    expect(write.status).toBe(400);
  });

  it("reads the key the edit would write, trimmed the same way", async () => {
    await patch({
      subjectKey: SUBJECT,
      expectedVersion: 0,
      changes: [{ repositoryKey: API, action: "select" }],
    });

    const res = await get(`?subjectKey=${encodeURIComponent(`  ${SUBJECT}  `)}`);

    expect(res.status).toBe(200);
    expect((await res.json()).entries.map((entry: { repositoryKey: string }) => entry.repositoryKey)).toEqual([
      API,
    ]);
  });

  it("refuses a caller with no session", async () => {
    state.sessionUserId = null;

    const res = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}`);

    expect(res.status).toBe(401);
  });

  it("refuses a signed in user who is not in the organization", async () => {
    state.sessionUserId = "user_outsider";

    const res = await get(`?subjectKey=${encodeURIComponent(SUBJECT)}`);

    expect(res.status).toBe(403);
  });
});
