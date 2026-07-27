import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { upsertMemoryDocument } from "../../../memory/store.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin" as string | null,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
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

const memoryGet = (await import("./memory.get.js")).default;

const SUBJECT_KEY = "ticket:jira:AIW-177";
const DOC_PATH = "blazebot/memory/AIW-177.md";

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function get(query = ""): Promise<Response> {
  return handlerFor(memoryGet)(new Request(`http://worker.test/${query}`));
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db
    .insert(user)
    .values({ id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true });
  await db
    .insert(member)
    .values({ id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" });
});

describe("GET /api/v1/memory", () => {
  it("returns an empty listing when nothing was remembered", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: [] });
  });

  it("lists documents newest first and without content", async () => {
    await upsertMemoryDocument(db, {
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: "AIW-177",
      content: "ticket notes",
      sourceRunId: "run_1",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertMemoryDocument(db, {
      subjectKey: "pr:github:acme/web#12",
      docPath: "blazebot/memory/pr-12.md",
      ticketKey: null,
      content: "pr notes",
      sourceRunId: "run_2",
    });

    const res = await get();
    const body = await res.json();
    expect(body.documents.map((d: { docPath: string }) => d.docPath)).toEqual([
      "blazebot/memory/pr-12.md",
      DOC_PATH,
    ]);
    expect(body.documents[0]).not.toHaveProperty("content");
    expect(body.documents[0].ticketKey).toBeNull();
    expect(body.documents[1]).toMatchObject({
      subjectKey: SUBJECT_KEY,
      ticketKey: "AIW-177",
      bytes: 12,
      sourceRunId: "run_1",
    });
    expect(typeof body.documents[1].updatedAt).toBe("string");
  });

  it("filters the listing by ticket key", async () => {
    await upsertMemoryDocument(db, {
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: "AIW-177",
      content: "ticket notes",
      sourceRunId: "run_1",
    });
    await upsertMemoryDocument(db, {
      subjectKey: "ticket:jira:AIW-9",
      docPath: "blazebot/memory/AIW-9.md",
      ticketKey: "AIW-9",
      content: "other notes",
      sourceRunId: "run_2",
    });

    const res = await get("?ticketKey=AIW-9");
    const body = await res.json();
    expect(body.documents.map((d: { ticketKey: string }) => d.ticketKey)).toEqual(["AIW-9"]);
  });

  it("returns one document with content when the key is given", async () => {
    await upsertMemoryDocument(db, {
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: "AIW-177",
      content: "# notes\nzażółć",
      sourceRunId: "run_1",
    });

    const res = await get(
      `?subjectKey=${encodeURIComponent(SUBJECT_KEY)}&docPath=${encodeURIComponent(DOC_PATH)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document).toMatchObject({
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      content: "# notes\nzażółć",
      sourceRunId: "run_1",
    });
  });

  it("404s on an unknown document key", async () => {
    const res = await get(`?subjectKey=${encodeURIComponent(SUBJECT_KEY)}&docPath=nope.md`);
    expect(res.status).toBe(404);
  });

  it("400s when only half of the document key is given", async () => {
    expect((await get("?docPath=nope.md")).status).toBe(400);
    expect((await get(`?subjectKey=${encodeURIComponent(SUBJECT_KEY)}`)).status).toBe(400);
  });

  it("401s without a session", async () => {
    state.sessionUserId = null;
    expect((await get()).status).toBe(401);
  });
});
