/**
 * CHARACTERIZATION: the Mem0 v1 adapter as production runs it today, on the
 * fake Mem0 in `test-support.ts`, before stage 5 writes the v2 adapter and
 * 1b stops sending notebooks here.
 *
 * Four behaviours the rebuild moves or changes, each pinned as it is:
 * skip (an item already held), refute (delete by id), cap (forget the oldest
 * learned), and notebook replace (add first, then delete older versions).
 * Where Mem0 decides "the same entry" differently from the built-in store
 * (exact text here, a folded key there), the test says so, because stage 4
 * and 5 unify it on purpose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryObserveRequest, MemoryScope } from "@integrations/sdk";
import { MEM0_NAMESPACE, mem0Memory } from "./memory";
import { fakeMem0, mem0Answering, type FakeMemory } from "./test-support";

const REPO = { key: "repo:github:acme/api", label: "acme/api" };
const TICKET = { key: "ticket:jira:AIW-7", label: "AIW-7" };
const FACTS: MemoryScope = { kind: "facts" };
const LESSONS: MemoryScope = { kind: "lessons" };
const NOTEBOOK: MemoryScope = { kind: "notebook", name: "AIW-7" };

/** A memory this integration wrote, created on 1 January 2026 plus `day`. */
function stored(
  memory: string,
  day: number,
  extra: Partial<FakeMemory> = {},
): Partial<FakeMemory> {
  const at = new Date(Date.UTC(2026, 0, day)).toISOString();
  return {
    memory,
    user_id: REPO.key,
    agent_id: "facts",
    app_id: MEM0_NAMESPACE,
    metadata: { origin: "learned" },
    created_at: at,
    updated_at: at,
    ...extra,
  };
}

function items(learned: string[], refuted: string[] = [], scope: MemoryScope = FACTS): MemoryObserveRequest {
  return {
    subject: REPO,
    scope,
    runId: "run_2",
    ticketKey: null,
    observation: { kind: "items", learned, refuted },
  };
}

function notebook(text: string): MemoryObserveRequest {
  return {
    subject: TICKET,
    scope: NOTEBOOK,
    runId: "run_3",
    ticketKey: "AIW-7",
    observation: { kind: "document", text },
  };
}

function against(mem0: ReturnType<typeof fakeMem0>) {
  const double = mem0Answering(mem0.handle);
  return { memory: mem0Memory(double.ctx), ...double };
}

/** Method and path of every request, the order Mem0 saw them in. */
function calls(sent: ReturnType<typeof against>["sent"]): string[] {
  return sent.map((request) => `${request.method} ${request.url.pathname}`);
}

// ---------------------------------------------------------------------------
// skip

test("skip: an item held under exactly the same text is not added again, and a case or full-stop variant is added beside it (changes in 5)", async () => {
  // Mistake that turns this red: sending a held text again, or adopting the
  // built-in store's folded comparison before stage 5 decides it.
  const mem0 = fakeMem0([stored("Uses pnpm 9", 1)]);
  const { memory, sent } = against(mem0);

  const write = await memory.observe(items(["Uses pnpm 9", "uses pnpm 9.", "Uses Node 20", "Uses Node 20"]));

  assert.deepEqual(write, { ok: true, stored: true, removed: 0, dropped: 0, remaining: 3 });
  const add = sent.find((request) => request.url.pathname === "/v3/memories/add/");
  assert.deepEqual(add?.body, {
    messages: [
      { role: "user", content: "uses pnpm 9." },
      { role: "user", content: "Uses Node 20" },
    ],
    user_id: REPO.key,
    agent_id: "facts",
    app_id: MEM0_NAMESPACE,
    metadata: { runId: "run_2", origin: "learned" },
    infer: false,
    immutable: true,
  });
  assert.deepEqual(
    mem0.memories.map((memory) => memory.memory),
    ["Uses pnpm 9", "uses pnpm 9.", "Uses Node 20"],
  );
});

test("pins current bug: an owner's fact left out of a repository recall by exact text only, so a differently spelled copy reaches the prompt twice", async () => {
  // Core asks a repository recall to leave out what the owner's document
  // already injected. The built-in store folds case and a final full stop;
  // this adapter compares exact text, so the repository's copy survives.
  const mem0 = fakeMem0([stored("Uses pnpm 9.", 1), stored("Tests run with vitest", 2)]);

  const recall = await against(mem0).memory.recall({ subject: REPO, scope: FACTS, exclude: ["uses pnpm 9"] });

  assert.deepEqual(recall.ok && recall.entries.map((entry) => entry.text), [
    "Tests run with vitest",
    "Uses pnpm 9.",
  ]);
});

// ---------------------------------------------------------------------------
// refute

test("refute: deletes by id only a memory whose text matches exactly; a paraphrase deletes nothing", async () => {
  const mem0 = fakeMem0([stored("Uses pnpm 9", 1), stored("Tests run with jest", 2)]);
  const jestId = mem0.memories[1]?.id ?? "";
  const { memory, sent } = against(mem0);

  const write = await memory.observe(items([], ["uses pnpm 9", "Tests run with jest"]));

  assert.deepEqual(write, { ok: true, stored: true, removed: 1, dropped: 0, remaining: 1 });
  assert.deepEqual(calls(sent), ["POST /v3/memories/", `DELETE /v1/memories/${jestId}/`]);
  assert.deepEqual(mem0.memories.map((memory) => memory.memory), ["Uses pnpm 9"]);
});

test("refute: an entry a run both learns and refutes is neither added nor, when held, kept", async () => {
  const mem0 = fakeMem0([stored("Build with make", 1)]);
  const { memory, sent } = against(mem0);

  const write = await memory.observe(items(["Build with make", "Lint with eslint"], ["Build with make", "Lint with eslint"]));

  assert.deepEqual(write, { ok: true, stored: true, removed: 1, dropped: 0, remaining: 0 });
  assert.equal(sent.some((request) => request.url.pathname === "/v3/memories/add/"), false);
  assert.deepEqual(mem0.memories, []);
});

// ---------------------------------------------------------------------------
// cap

test("cap: an add past 40 facts forgets the oldest learned facts by id, never a derived one", async () => {
  const held = [
    stored("Package manager is pnpm.", 1, { metadata: { origin: "derived" } }),
    stored("Run tests with: pnpm test", 2, { metadata: { origin: "derived" } }),
    ...Array.from({ length: 38 }, (_, index) => stored(`Learned ${index + 1}`, index + 3)),
  ];
  const mem0 = fakeMem0(held);

  const write = await against(mem0).memory.observe(items(["New 1", "New 2", "New 3"]));

  assert.deepEqual(write, { ok: true, stored: true, removed: 0, dropped: 3, remaining: 40 });
  const texts = mem0.memories.map((memory) => memory.memory);
  assert.equal(texts.length, 40);
  for (const gone of ["Learned 1", "Learned 2", "Learned 3"]) assert.equal(texts.includes(gone), false, gone);
  for (const kept of ["Package manager is pnpm.", "Run tests with: pnpm test", "Learned 4", "New 3"]) {
    assert.equal(texts.includes(kept), true, kept);
  }
});

test("cap: lessons stop at 30, and a pure retraction never trims however much is held", async () => {
  const lessons = Array.from({ length: 30 }, (_, index) =>
    stored(`Lesson ${index + 1}`, index + 1, { agent_id: "lessons" }),
  );
  const lessonWrite = await against(fakeMem0(lessons)).memory.observe(items(["New lesson"], [], LESSONS));
  assert.deepEqual(lessonWrite, { ok: true, stored: true, removed: 0, dropped: 1, remaining: 30 });

  const overfull = Array.from({ length: 45 }, (_, index) => stored(`Fact ${index + 1}`, index + 1));
  const retraction = await against(fakeMem0(overfull)).memory.observe(items([], ["Fact 45"]));
  assert.deepEqual(retraction, { ok: true, stored: true, removed: 1, dropped: 0, remaining: 44 });
});

// ---------------------------------------------------------------------------
// notebook replace

test("notebook replace: filed under notebook/<name> for the ticket subject, the new version is added first and every older version then deleted", async () => {
  // Mistake: deleting before the add is confirmed (a failure between the two
  // leaves no notebook), or appending, so the next run reads two versions.
  const mem0 = fakeMem0([
    stored("# v1", 1, { user_id: TICKET.key, agent_id: "notebook/AIW-7", metadata: { origin: "notebook" } }),
    stored("# v2", 2, { user_id: TICKET.key, agent_id: "notebook/AIW-7", metadata: { origin: "notebook" } }),
  ]);
  const { memory, sent } = against(mem0);

  const write = await memory.observe(notebook("# v3"));

  assert.deepEqual(write, { ok: true, stored: true, removed: 2, dropped: 0, remaining: 1 });
  assert.deepEqual(
    calls(sent).map((call) => call.replace(/\/v1\/memories\/[^/]+\//u, "/v1/memories/{id}/")),
    ["POST /v3/memories/", "POST /v3/memories/add/", "DELETE /v1/memories/{id}/", "DELETE /v1/memories/{id}/"],
  );
  assert.deepEqual(sent[0]?.body, {
    filters: { AND: [{ app_id: MEM0_NAMESPACE }, { user_id: TICKET.key }, { agent_id: "notebook/AIW-7" }] },
  });
  assert.deepEqual(sent[1]?.body, {
    messages: [{ role: "user", content: "# v3" }],
    user_id: TICKET.key,
    agent_id: "notebook/AIW-7",
    app_id: MEM0_NAMESPACE,
    metadata: { runId: "run_3", ticketKey: "AIW-7", origin: "notebook" },
    infer: false,
    immutable: true,
  });
  const read = await memory.recall({ subject: TICKET, scope: NOTEBOOK });
  assert.deepEqual(read, { ok: true, held: true, entries: [{ text: "# v3" }], rendering: "# v3" });
});

test("notebook replace: an unchanged notebook keeps its newest identical copy, adds nothing and deletes the rest", async () => {
  const mem0 = fakeMem0([
    stored("# Plan", 1, { user_id: TICKET.key, agent_id: "notebook/AIW-7" }),
    stored("# Older plan", 2, { user_id: TICKET.key, agent_id: "notebook/AIW-7" }),
    stored("# Plan", 3, { user_id: TICKET.key, agent_id: "notebook/AIW-7" }),
  ]);
  const { memory, sent } = against(mem0);

  const write = await memory.observe(notebook("# Plan"));

  assert.deepEqual(write, { ok: true, stored: true, removed: 2, dropped: 0, remaining: 1 });
  assert.equal(sent.some((request) => request.url.pathname === "/v3/memories/add/"), false);
  assert.deepEqual(
    mem0.memories.map((memory) => [memory.memory, memory.created_at]),
    [["# Plan", new Date(Date.UTC(2026, 0, 3)).toISOString()]],
  );
});

test("notebook recall reads only the newest version held", async () => {
  const mem0 = fakeMem0([
    stored("# newest", 5, { user_id: TICKET.key, agent_id: "notebook/AIW-7" }),
    stored("# oldest", 1, { user_id: TICKET.key, agent_id: "notebook/AIW-7" }),
  ]);

  const read = await against(mem0).memory.recall({ subject: TICKET, scope: NOTEBOOK });

  assert.deepEqual(read, { ok: true, held: true, entries: [{ text: "# newest" }], rendering: "# newest" });
});

test("changes in 6b: facts are recalled derived first, then newest first, each text once", async () => {
  const mem0 = fakeMem0([
    stored("Old learned", 1),
    stored("Seeded", 2, { metadata: { origin: "derived" } }),
    stored("New learned", 3),
    stored("Old learned", 4),
  ]);

  const read = await against(mem0).memory.recall({ subject: REPO, scope: FACTS });

  assert.deepEqual(read, {
    ok: true,
    held: true,
    entries: [{ text: "Seeded" }, { text: "Old learned" }, { text: "New learned" }],
    rendering: "- Seeded\n- Old learned\n- New learned",
  });
});
