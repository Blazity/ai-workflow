import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { agentMemoryDocuments, member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { getMemoryDocument, upsertMemoryDocument } from "../../../memory/store.js";

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
const memoryDelete = (await import("./memory.delete.js")).default;

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

function del(query = ""): Promise<Response> {
  return handlerFor(memoryDelete)(
    new Request(`http://worker.test/${query}`, { method: "DELETE" }),
  );
}

function documentQuery(subjectKey: string, docPath: string): string {
  return `?subjectKey=${encodeURIComponent(subjectKey)}&docPath=${encodeURIComponent(docPath)}`;
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
  await db
    .insert(user)
    .values({ id: "user_member", name: "Member", email: "member@example.com", emailVerified: true });
  await db.insert(member).values({
    id: "member_member",
    organizationId: "org_aiw",
    userId: "user_member",
    role: "member",
  });
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

describe("DELETE /api/v1/memory", () => {
  async function seed(subjectKey: string, docPath: string, content = "remembered"): Promise<void> {
    await upsertMemoryDocument(db, {
      subjectKey,
      docPath,
      ticketKey: null,
      content,
      sourceRunId: "run_1",
    });
  }

  async function countRows(): Promise<number> {
    return (await db.select().from(agentMemoryDocuments)).length;
  }

  it("hard deletes the document and reports success", async () => {
    await seed(SUBJECT_KEY, DOC_PATH, "sensitive text");

    const res = await del(documentQuery(SUBJECT_KEY, DOC_PATH));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH)).toBeNull();
    expect(await countRows()).toBe(0);
    expect((await get(documentQuery(SUBJECT_KEY, DOC_PATH))).status).toBe(404);
  });

  it("404s on a document that was never stored instead of claiming success", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);

    expect((await del(documentQuery(SUBJECT_KEY, "blazebot/memory/nope.md"))).status).toBe(404);
    expect((await del(documentQuery("ticket:jira:AIW-404", DOC_PATH))).status).toBe(404);
    expect(await countRows()).toBe(1);
  });

  it("404s on the second delete of the same document", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);

    expect((await del(documentQuery(SUBJECT_KEY, DOC_PATH))).status).toBe(200);
    expect((await del(documentQuery(SUBJECT_KEY, DOC_PATH))).status).toBe(404);
  });

  it("removes only the addressed document, not every path of the subject", async () => {
    await seed(SUBJECT_KEY, DOC_PATH, "target");
    await seed(SUBJECT_KEY, "blazebot/memory/lessons.md", "sibling");
    await seed("repo:github:acme/web", DOC_PATH, "other subject");

    expect((await del(documentQuery(SUBJECT_KEY, DOC_PATH))).status).toBe(200);

    expect(await countRows()).toBe(2);
    expect(
      (await getMemoryDocument(db, SUBJECT_KEY, "blazebot/memory/lessons.md"))?.content,
    ).toBe("sibling");
    expect((await getMemoryDocument(db, "repo:github:acme/web", DOC_PATH))?.content).toBe(
      "other subject",
    );
  });

  it("400s when only half of the document key is given", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);

    expect((await del(`?subjectKey=${encodeURIComponent(SUBJECT_KEY)}`)).status).toBe(400);
    expect((await del(`?docPath=${encodeURIComponent(DOC_PATH)}`)).status).toBe(400);
    expect((await del()).status).toBe(400);
    expect(await countRows()).toBe(1);
  });

  it("treats SQL metacharacters in the key as literal text", async () => {
    const hostileSubject = "ticket:jira:AIW-177'; DROP TABLE agent_memory_documents; --";
    const hostilePath = "a.md' OR '1'='1";
    await seed(SUBJECT_KEY, DOC_PATH, "keep me");
    await seed(hostileSubject, hostilePath, "hostile key, real row");

    expect((await del(documentQuery(hostileSubject, hostilePath))).status).toBe(200);
    expect(await countRows()).toBe(1);
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe("keep me");

    expect((await del(documentQuery("' OR 1=1 --", "' OR 1=1 --"))).status).toBe(404);
    expect(await countRows()).toBe(1);
  });

  it("rejects an oversized key and matches nothing for a traversal shape", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);

    expect((await del(documentQuery("x".repeat(1000), "y".repeat(1000)))).status).toBe(400);
    expect((await del(documentQuery(SUBJECT_KEY, "../../etc/passwd"))).status).toBe(404);
    expect((await del(documentQuery(SUBJECT_KEY, "blazebot/memory/../AIW-177.md"))).status).toBe(
      404,
    );
    expect((await del(documentQuery(SUBJECT_KEY, "%"))).status).toBe(404);
    expect(await countRows()).toBe(1);
  });

  it("403s a member and leaves the document in place", async () => {
    await seed(SUBJECT_KEY, DOC_PATH, "still here");
    state.sessionUserId = "user_member";

    const res = await del(documentQuery(SUBJECT_KEY, DOC_PATH));

    expect(res.status).toBe(403);
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe("still here");
    expect(await countRows()).toBe(1);
  });

  it("401s without a session and leaves the document in place", async () => {
    await seed(SUBJECT_KEY, DOC_PATH, "still here");
    state.sessionUserId = null;

    expect((await del(documentQuery(SUBJECT_KEY, DOC_PATH))).status).toBe(401);
    expect(await countRows()).toBe(1);
  });

  it("403s a signed-in user outside the dashboard organization", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);
    await db
      .insert(user)
      .values({ id: "user_alien", name: "Alien", email: "alien@example.com", emailVerified: true });
    state.sessionUserId = "user_alien";

    expect((await del(documentQuery(SUBJECT_KEY, DOC_PATH))).status).toBe(403);
    expect(await countRows()).toBe(1);
  });
});
