import { eq } from "drizzle-orm";
import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import type {
  MemoryAdapter,
  MemoryStoreAdapter,
  MemoryStoredDocumentRef,
  MemoryStoredSummary,
} from "@integrations/sdk";
import type { ActiveMemory } from "../../../engine/support/memory-runtime.js";
import { agentMemoryDocuments, member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { getMemoryDocument, upsertMemoryDocument } from "../../../memory/store.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin" as string | null,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
  /** Non-null puts a different memory provider behind all three routes. */
  memory: null as unknown,
  /** Non-null is what this deployment's integration rows answer: a memory
   *  integration connected, resolved by the real `activeMemory`. */
  integrations: null as null | { usable: unknown[]; states: Map<string, unknown> },
}));

vi.mock("../../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../../services/integrations/runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/integrations/runtime.js")>();
  return {
    ...actual,
    resolveUsableIntegrations: (async (input) =>
      state.integrations
        ? {
            readable: true as const,
            usable: state.integrations.usable,
            states: state.integrations.states,
            connectionFailures: new Map(),
          }
        : actual.resolveUsableIntegrations(input)) as typeof actual.resolveUsableIntegrations,
  };
});
// Every test below runs against the real built-in provider unless it puts
// another one in `state.memory`, which is how the provider-shaped answers
// (501 and 503) get exercised without a second database.
vi.mock("../../../engine/support/memory-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../engine/support/memory-runtime.js")>();
  return {
    ...actual,
    activeMemory: async (): Promise<ActiveMemory> =>
      (state.memory as ActiveMemory | null) ?? (await actual.activeMemory()),
  };
});
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

const memoryGet = (await import("./memory.get.js")).default;
const memoryDelete = (await import("./memory.delete.js")).default;
const { activeMemory } = await import("../../../engine/support/memory-runtime.js");

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
  state.memory = null;
  state.integrations = null;
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
    // `complete: true` is the provider saying this listing is everything it
    // holds. An engine that cannot promise that answers false, and the screen
    // says so rather than letting a person read absence as proof.
    expect(await res.json()).toEqual({ documents: [], complete: true });
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

  it("400s a docPath without the subjectKey it is stored under", async () => {
    expect((await get("?docPath=nope.md")).status).toBe(400);
  });

  it("lists one subject's documents whatever their age on a busy deployment", async () => {
    // A repository nobody has run on lately: its two documents are older than
    // the hundred-and-twenty other subjects' written since, so the newest
    // page of everything does not reach them. The repository page and
    // memory.list ask for the subject instead of paging for it.
    const REPO = "repo:github:acme/web";
    for (const docPath of ["facts", "lessons"]) {
      await upsertMemoryDocument(db, {
        subjectKey: REPO,
        docPath,
        ticketKey: null,
        content: `${docPath} of acme/web`,
        sourceRunId: "run_old",
      });
    }
    await db
      .update(agentMemoryDocuments)
      .set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(agentMemoryDocuments.subjectKey, REPO));
    for (let index = 0; index < 120; index += 1) {
      await upsertMemoryDocument(db, {
        subjectKey: `ticket:jira:AIW-${index}`,
        docPath: `ai-workflow/memory/AIW-${index}.md`,
        ticketKey: `AIW-${index}`,
        content: "notes",
        sourceRunId: `run_${index}`,
      });
    }

    // The premise: the unfiltered listing is a page that does not reach them.
    const everything = await (await get()).json();
    expect(everything.complete).toBe(false);
    expect(
      everything.documents.some((d: { subjectKey: string }) => d.subjectKey === REPO),
    ).toBe(false);

    const res = await get(`?subjectKey=${encodeURIComponent(REPO)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complete).toBe(true);
    expect(
      body.documents.map((d: { subjectKey: string; docPath: string }) => `${d.subjectKey} ${d.docPath}`),
    ).toEqual([`${REPO} facts`, `${REPO} lessons`]);
  });

  it("400s a subjectKey no agent could have written", async () => {
    expect((await get(`?subjectKey=${"x".repeat(1000)}`)).status).toBe(400);
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

/**
 * A memory provider that is not the built-in one, which is the only way to
 * reach the two answers these routes owe a client about the provider itself.
 *
 * `store: null` and "the store threw" are different facts and the routes must
 * not collapse them: one says stop asking, the other says ask again.
 */
function provider(store: ActiveMemory["store"]): ActiveMemory {
  return {
    id: "acme-memory",
    name: "Acme Memory",
    refusal: null,
    store,
    recall: () => Promise.reject(new Error("these routes never recall")),
    observe: () => Promise.reject(new Error("these routes never observe")),
  };
}

const AWAY = {
  list: () => Promise.reject(new Error("upstream timed out")),
  read: () => Promise.reject(new Error("upstream timed out")),
  forget: () => Promise.reject(new Error("upstream timed out")),
};

describe("memory routes answer for the provider, not for the store", () => {
  async function statuses(): Promise<number[]> {
    return [
      (await get()).status,
      (await get(documentQuery(SUBJECT_KEY, DOC_PATH))).status,
      (await del(documentQuery(SUBJECT_KEY, DOC_PATH))).status,
    ];
  }

  it("501s every route when the provider serves runs without an enumerable store", async () => {
    state.memory = provider(null);

    // 501 and not 503: this deployment's memory works, it just cannot be
    // browsed from here, and no amount of retrying changes that. A single
    // route answering 503 sends an admin to look for an outage that is not
    // happening.
    expect(await statuses()).toEqual([501, 501, 501]);
  });

  it("503s every route when the provider is away, and names it", async () => {
    state.memory = provider(AWAY);

    expect(await statuses()).toEqual([503, 503, 503]);
    const body = await (await get(documentQuery(SUBJECT_KEY, DOC_PATH))).text();
    expect(body).toContain("Acme Memory");
    // The next step travels with it: a screen quoting this sentence has no
    // other way to know that waiting, then the connection, is the fix.
    expect(body).toContain("Try again in a moment");
    expect(body).toContain("Integrations page");
  });

  it("404s the document rather than 501 when the provider can enumerate", async () => {
    state.memory = provider({
      list: async () => ({ documents: [], complete: true }),
      read: async () => null,
      forget: async () => false,
    });

    // The guard on the fix above: a reachable provider that holds nothing
    // still owes a person "no such document", not "this cannot be browsed".
    expect(await statuses()).toEqual([200, 404, 404]);
  });
});

/**
 * Mem0 connected, as the deployment's rows answer it, serving facts and
 * lessons. Its store has the real one's addresses (`integrations/mem0/memory.ts`):
 * `facts`, `lessons` and `notebook/<KEY>`. It holds a repository's facts and
 * the notebook production's Mem0 kept for this ticket before notebooks stopped
 * going there, and records every read and erase it is asked for.
 */
function mem0Serves({ complete = true }: { complete?: boolean } = {}) {
  const at = new Date("2026-09-20T10:00:00.000Z");
  const stored = (subjectKey: string, docPath: string, ticketKey: string | null, content: string) => ({
    subjectKey,
    docPath,
    ticketKey,
    content,
    bytes: content.length,
    sourceRunId: "run_mem0",
    createdAt: at,
    updatedAt: at,
  });
  const held = [
    stored("repo:github:acme/web", "facts", null, "- uses pnpm"),
    stored(SUBJECT_KEY, "notebook/AIW-177", "AIW-177", "# the copy Mem0 kept"),
  ];
  const asked = { reads: [] as MemoryStoredDocumentRef[], erasures: [] as MemoryStoredDocumentRef[], runs: 0 };
  const find = (ref: MemoryStoredDocumentRef) =>
    held.find((document) => document.subjectKey === ref.subjectKey && document.docPath === ref.docPath);
  const store: MemoryStoreAdapter = {
    async list(options) {
      const documents: MemoryStoredSummary[] = held
        .filter(
          (document) =>
            (options.subjectKey === undefined || document.subjectKey === options.subjectKey) &&
            (options.ticketKey === undefined || document.ticketKey === options.ticketKey),
        )
        .map(({ content: _content, ...summary }) => summary);
      return { documents, complete };
    },
    async read(ref) {
      asked.reads.push(ref);
      const document = find(ref);
      return document
        ? { content: document.content, bytes: document.bytes, updatedAt: document.updatedAt, sourceRunId: document.sourceRunId }
        : null;
    },
    async forget(ref) {
      asked.erasures.push(ref);
      const document = find(ref);
      if (!document) return false;
      held.splice(held.indexOf(document), 1);
      return true;
    },
  };
  const adapter: MemoryAdapter = {
    recall: async () => {
      asked.runs += 1;
      return { ok: true, held: false, entries: [], rendering: "" };
    },
    observe: async () => {
      asked.runs += 1;
      return { ok: true, stored: true, removed: 0, dropped: 0, remaining: 1 };
    },
    store,
  };
  state.integrations = {
    usable: [
      {
        manifest: { id: "mem0", name: "Mem0", capabilities: ["memory"] },
        runtime: { capabilities: { memory: () => adapter } },
        ctx: {},
        redaction: { text: (text: string) => text },
      },
    ],
    states: new Map([
      [
        "mem0",
        { integrationId: "mem0", status: "connected", connection: "connected", enabled: true, usable: true, failure: null },
      ],
    ]),
  };
  return asked;
}

/**
 * A ticket's notebook is the built-in store's on every deployment, so on one
 * Mem0 serves the memory screen and the MCP tools must still show it, read it
 * and erase it. It holds what people answered in clarification rounds, by
 * name: an erasure request for it that answers "nothing there" leaves it
 * stored.
 */
describe("memory routes on a deployment Mem0 serves", () => {
  const REPO = "repo:github:acme/web";
  const NOTEBOOK = [
    "# Session Memory: AIW-177",
    "",
    "<!-- human-decisions:start -->",
    "### Round 1 (answered by Ada Lovelace)",
    "1. Ship it behind a flag?",
    "",
    "Answer: yes",
    "<!-- human-decisions:end -->",
    "",
  ].join("\n");

  /** Written the way a run's teardown writes it, through the real store. */
  async function runStoresNotebook(): Promise<void> {
    const written = await (await activeMemory()).observe({
      subject: { key: SUBJECT_KEY, label: "AIW-177" },
      scope: { kind: "notebook", name: "AIW-177" },
      runId: "run_9",
      ticketKey: "AIW-177",
      observation: { kind: "document", text: NOTEBOOK },
    });
    expect(written).toMatchObject({ ok: true, stored: true });
  }

  /** What the built-in store kept from before Mem0 was connected, which
   *  nothing serves while Mem0 does. */
  async function builtinKeptFactsFromBefore(): Promise<void> {
    await upsertMemoryDocument(db, {
      subjectKey: REPO,
      docPath: "facts",
      ticketKey: null,
      content: "- from before Mem0",
      sourceRunId: "run_old",
    });
  }

  const pairs = (body: { documents: { subjectKey: string; docPath: string }[] }) =>
    body.documents.map((document) => `${document.subjectKey} ${document.docPath}`).sort();

  it("lists the ticket's notebook beside what Mem0 holds, shows it, and erases it once", async () => {
    // Mistake that turns this red: handing the memory screen Mem0's store
    // alone, which answers a complete listing without the notebook, no
    // document for its address and "nothing there" to the erasure.
    const mem0 = mem0Serves();
    await builtinKeptFactsFromBefore();
    await runStoresNotebook();
    const notebookPath = "ai-workflow/memory/AIW-177.md";

    const listed = await (await get()).json();
    expect(pairs(listed)).toEqual(
      [`${REPO} facts`, `${SUBJECT_KEY} ${notebookPath}`, `${SUBJECT_KEY} notebook/AIW-177`].sort(),
    );
    expect(listed.complete).toBe(true);
    expect(pairs(await (await get("?ticketKey=AIW-177")).json())).toEqual(
      [`${SUBJECT_KEY} ${notebookPath}`, `${SUBJECT_KEY} notebook/AIW-177`].sort(),
    );

    const shown = await get(documentQuery(SUBJECT_KEY, notebookPath));
    expect(shown.status).toBe(200);
    expect((await shown.json()).document).toMatchObject({ content: NOTEBOOK, sourceRunId: "run_9" });

    const erased = await del(documentQuery(SUBJECT_KEY, notebookPath));
    expect(erased.status).toBe(200);
    expect(await erased.json()).toEqual({ deleted: true });
    expect(await getMemoryDocument(db, SUBJECT_KEY, notebookPath)).toBeNull();
    expect((await del(documentQuery(SUBJECT_KEY, notebookPath))).status).toBe(404);
    expect((await get(documentQuery(SUBJECT_KEY, notebookPath))).status).toBe(404);

    expect(mem0.reads).toEqual([]);
    expect(mem0.erasures).toEqual([]);
    expect(mem0.runs).toBe(0);
  });

  it("keeps facts and lessons Mem0's: its listing of a repository is unchanged, and its own notebook address still reaches it", async () => {
    // The Q14 wipe erases through `memory_forget`, by the `notebook/<KEY>`
    // addresses Mem0 lists, so those must stay Mem0's.
    const mem0 = mem0Serves();
    await builtinKeptFactsFromBefore();

    const repository = await (await get(`?subjectKey=${encodeURIComponent(REPO)}`)).json();
    expect(repository).toMatchObject({
      documents: [{ subjectKey: REPO, docPath: "facts", sourceRunId: "run_mem0" }],
      complete: true,
    });
    expect(repository.documents).toHaveLength(1);

    expect(await (await get(documentQuery(REPO, "facts"))).json()).toMatchObject({
      document: { content: "- uses pnpm" },
    });
    expect((await del(documentQuery(SUBJECT_KEY, "notebook/AIW-177"))).status).toBe(200);
    expect((await del(documentQuery(REPO, "facts"))).status).toBe(200);
    expect(mem0.erasures).toEqual([
      { subjectKey: SUBJECT_KEY, docPath: "notebook/AIW-177" },
      { subjectKey: REPO, docPath: "facts" },
    ]);
    expect((await getMemoryDocument(db, REPO, "facts"))?.content).toBe("- from before Mem0");
  });

  it("shows and erases a notebook an older run filed under the legacy directory", async () => {
    mem0Serves();
    const legacyPath = "blazebot/memory/AIW-9.md";
    await upsertMemoryDocument(db, {
      subjectKey: "ticket:jira:AIW-9",
      docPath: legacyPath,
      ticketKey: "AIW-9",
      content: "# AIW-9, from an older run",
      sourceRunId: "run_legacy",
    });
    // The premise: the built-in store still reads a notebook from there.
    expect(
      await (await activeMemory()).recall({
        subject: { key: "ticket:jira:AIW-9", label: "AIW-9" },
        scope: { kind: "notebook", name: "AIW-9" },
      }),
    ).toMatchObject({ ok: true, held: true, rendering: "# AIW-9, from an older run" });

    expect(pairs(await (await get("?ticketKey=AIW-9")).json())).toEqual([`ticket:jira:AIW-9 ${legacyPath}`]);
    expect((await get(documentQuery("ticket:jira:AIW-9", legacyPath))).status).toBe(200);
    expect((await del(documentQuery("ticket:jira:AIW-9", legacyPath))).status).toBe(200);
    expect(await getMemoryDocument(db, "ticket:jira:AIW-9", legacyPath)).toBeNull();
  });

  it("says the listing may be partial when Mem0's is", async () => {
    mem0Serves({ complete: false });
    await runStoresNotebook();

    const listed = await (await get()).json();
    expect(listed.complete).toBe(false);
    expect(pairs(listed)).toContain(`${SUBJECT_KEY} ai-workflow/memory/AIW-177.md`);
  });
});
