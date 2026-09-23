/**
 * The memory port on Mem0, called at the HTTP boundary. Each test names the
 * mistake that turns it red.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryObserveRequest, MemoryScope } from "@integrations/sdk";
import { MEM0_NAMESPACE, mem0Memory, quotes } from "./memory";
import {
  FAKE_KEY,
  fakeMem0,
  json,
  mem0Answering,
  recorded,
  recordedJson,
  undocumented,
  type FakeMemory,
} from "./test-support";

const REPO = { key: "repo:github:acme/api", label: "acme/api" };
const TICKET = { key: "ticket:jira:AIW-1", label: "AIW-1" };
const FACTS: MemoryScope = { kind: "facts" };
const NOTEBOOK: MemoryScope = { kind: "notebook", name: "AIW-1" };

function held(memory: string, extra: Partial<FakeMemory> = {}): Partial<FakeMemory> {
  return { memory, user_id: REPO.key, agent_id: "facts", app_id: MEM0_NAMESPACE, metadata: { origin: "learned" }, ...extra };
}

function items(learned: string[], refuted: string[] = [], extra: object = {}): MemoryObserveRequest {
  return { subject: REPO, scope: FACTS, runId: "run_2", ticketKey: null, observation: { kind: "items", learned, refuted, ...extra } };
}

function notebook(text: string, runId = "run_1"): MemoryObserveRequest {
  return { subject: TICKET, scope: NOTEBOOK, runId, ticketKey: "AIW-1", observation: { kind: "document", text } };
}

function against(mem0: ReturnType<typeof fakeMem0>) {
  const double = mem0Answering(mem0.handle);
  return { memory: mem0Memory(double.ctx), ...double };
}

// ---------------------------------------------------------------------------
// recall

test("recall renders the documented listing, newest first", async () => {
  // Mistake: reading a field other than `memory`, or trusting get-all's order,
  // which Mem0 does not document.
  const { memory } = mem0AnsweringWith(recorded("get-memories.json"));
  const answer = await memory.recall({ subject: REPO, scope: FACTS });
  assert.deepEqual(answer, {
    ok: true,
    held: true,
    entries: [
      { text: "Alex prefers vegetarian restaurants" },
      { text: "Alex is planning a trip to San Francisco from July 1st to July 10th" },
    ],
    rendering: "- Alex prefers vegetarian restaurants\n- Alex is planning a trip to San Francisco from July 1st to July 10th",
  });
});

test("recall asks only for this namespace, this subject and this scope, never a run", async () => {
  // Mistake: leaving the namespace off, which hands a chatbot's memories in
  // the same project to a prompt (Mem0 does not constrain a field a filter
  // leaves out).
  const { memory, sent } = mem0AnsweringWith(recorded("get-memories.json"));
  await memory.recall({ subject: REPO, scope: FACTS });
  assert.equal(sent[0]?.method, "POST");
  assert.equal(sent[0]?.url.pathname, "/v3/memories/");
  assert.deepEqual(sent[0]?.body, {
    filters: { AND: [{ app_id: MEM0_NAMESPACE }, { user_id: REPO.key }, { agent_id: "facts" }] },
  });
  assert.equal(sent[0]?.headers.get("authorization"), `Token ${FAKE_KEY}`);
});

test("another application's memories in the same project never come back", async () => {
  const mem0 = fakeMem0([
    held("Uses pnpm 9"),
    { memory: "Customer prefers email", user_id: REPO.key, agent_id: "facts", app_id: "support-bot" },
    { memory: "Customer is vegan", user_id: "customer_6412", agent_id: null, app_id: null },
  ]);
  const answer = await against(mem0).memory.recall({ subject: REPO, scope: FACTS });
  assert.deepEqual(answer.ok && answer.entries, [{ text: "Uses pnpm 9" }]);
});

test("derived entries come first, because core cuts a long rendering from the end", async () => {
  const mem0 = fakeMem0([
    held("Package manager: pnpm", { metadata: { origin: "derived" }, created_at: "2026-01-01T00:00:00Z" }),
    held("Flaky test in auth suite", { created_at: "2026-09-01T00:00:00Z" }),
  ]);
  const answer = await against(mem0).memory.recall({ subject: REPO, scope: FACTS });
  assert.deepEqual(answer.ok && answer.entries.map((entry) => entry.text), [
    "Package manager: pnpm",
    "Flaky test in auth suite",
  ]);
});

for (const [name, answer] of [
  ["an HTML page with 200", () => new Response("<html>Bad gateway</html>", { status: 200 })],
  ["an empty 200", () => new Response("", { status: 200 })],
  ["JSON without results", () => json({ count: 0, next: null, previous: null })],
] as const) {
  test(`recall reads ${name} as unavailable, never as holding nothing`, async () => {
    // Mistake: `held: false` for a body it could not read, which makes the seed
    // write into a full store and a run take an old file for its notebook.
    const { memory } = mem0AnsweringWith(answer());
    const read = await memory.recall({ subject: REPO, scope: FACTS });
    assert.equal(read.ok, false);
    assert.equal(!read.ok && read.code, "unavailable");
    assert.doesNotMatch(!read.ok ? read.detail : "", /html/iu);
  });
}

test("a rate limit is unavailable and says so, whatever it asks to wait", async () => {
  const { memory } = mem0AnsweringWith(undocumented.rateLimited("3600"));
  const read = await memory.recall({ subject: REPO, scope: FACTS });
  assert.equal(!read.ok && read.code, "unavailable");
  assert.match(!read.ok ? read.detail : "", /rate limited/u);
});

test("a refused key is rejected, not unavailable", async () => {
  const { memory } = mem0AnsweringWith(recorded("ping-unauthorized.json", 401));
  const read = await memory.recall({ subject: REPO, scope: FACTS });
  assert.deepEqual(read, { ok: false, code: "rejected", detail: "Mem0 refused the API key for a listing (401)." });
});

test("recall and observe answer rather than throw when the request never completes", async () => {
  // Mistake: letting a TimeoutError out of the adapter. Core would catch it,
  // but the port says a failure is an answer.
  const { ctx, sent } = mem0Answering(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const memory = mem0Memory(ctx);
  const read = await memory.recall({ subject: REPO, scope: FACTS });
  const write = await memory.observe(items(["Uses pnpm 9"]));
  assert.equal(!read.ok && read.code, "unavailable");
  assert.equal(!write.ok && write.code, "unavailable");
  // After the first call hung, the second sent nothing: a Mem0 that does not
  // answer costs a step one attempt, not one per call.
  assert.equal(sent.length, 1);
  assert.match(!write.ok ? write.detail : "", /not asked again/u);
});

test("a subject or notebook name holding * is refused before anything is sent", async () => {
  // Mistake: handing `*` to a filter, where Mem0 reads it as every value.
  const mem0 = fakeMem0([held("Uses pnpm 9")]);
  const { memory, sent } = against(mem0);
  const read = await memory.recall({ subject: { key: "*", label: "*" }, scope: FACTS });
  const write = await memory.observe({ ...notebook("x"), scope: { kind: "notebook", name: "*" } });
  assert.equal(!read.ok && read.code, "rejected");
  assert.equal(!write.ok && write.code, "rejected");
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------------------
// observe: items

test("an item is added verbatim, synchronously, under the namespace, with provenance only in metadata", async () => {
  const mem0 = fakeMem0();
  const { memory, sent } = against(mem0);
  const write = await memory.observe(items(["Uses pnpm 9"]));
  assert.deepEqual(write, { ok: true, stored: true, removed: 0, dropped: 0, remaining: 1 });
  const add = sent.find((request) => request.url.pathname === "/v3/memories/add/");
  assert.deepEqual(add?.body, {
    messages: [{ role: "user", content: "Uses pnpm 9" }],
    user_id: REPO.key,
    agent_id: "facts",
    app_id: MEM0_NAMESPACE,
    metadata: { runId: "run_2", origin: "learned" },
    infer: false,
    immutable: true,
  });
  assert.equal(Object.hasOwn(add?.body ?? {}, "run_id"), false);
});

test("an item already held is not stored again", async () => {
  const mem0 = fakeMem0([held("Uses pnpm 9")]);
  const { memory, sent } = against(mem0);
  const write = await memory.observe(items(["Uses pnpm 9"]));
  assert.deepEqual(write, { ok: true, stored: false, removed: 0, dropped: 0, remaining: 1 });
  assert.equal(sent.some((request) => request.url.pathname === "/v3/memories/add/"), false);
});

test("a refuted fact is deleted by id and the next recall holds only the new one", async () => {
  // Mistake: passing the observation to an add-only engine, so "jest" and
  // "vitest" both reach the next prompt.
  const mem0 = fakeMem0([held("Tests run with jest"), held("Uses pnpm 9")]);
  const { memory, sent } = against(mem0);
  const write = await memory.observe(items(["Tests run with vitest"], ["Tests run with jest"]));
  assert.deepEqual(write, { ok: true, stored: true, removed: 1, dropped: 0, remaining: 2 });
  const deletes = sent.filter((request) => request.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.match(deletes[0]?.url.pathname ?? "", /^\/v1\/memories\/[^/]+\/$/u);
  const next = await memory.recall({ subject: REPO, scope: FACTS });
  assert.deepEqual(next.ok && next.entries.map((entry) => entry.text).sort(), ["Tests run with vitest", "Uses pnpm 9"]);
});

test("removed counts only the deletes Mem0 confirmed", async () => {
  const mem0 = fakeMem0([held("Tests run with jest")], (sent) =>
    sent.method === "DELETE" ? recorded("memory-not-found.json", 404) : undefined,
  );
  const write = await against(mem0).memory.observe(items([], ["Tests run with jest"]));
  // Mem0 said it was not there (404), so it is not counted and not held.
  assert.deepEqual(write, { ok: true, stored: false, removed: 0, dropped: 0, remaining: 0 });
});

test("a refutation quoting a redacted secret still finds the raw stored text", () => {
  // Mistake: comparing the cleaned quote with the raw stored text, so that
  // entry is never retracted.
  assert.equal(quotes("Token is [REDACTED:configured_secret] in CI", "Token is abc123 in CI"), true);
  assert.equal(quotes("Token is [REDACTED:configured_secret] in CI", "Token is abc 123 in CI"), false);
  assert.equal(quotes("Tests run with jest", "Tests run with jest."), false);
});

test("a seed writes nothing where anything is held, and never deletes", async () => {
  const mem0 = fakeMem0([held("Written by a run")]);
  const { memory, sent } = against(mem0);
  const write = await memory.observe(items(["Package manager: pnpm"], [], { derived: true, onlyIfEmpty: true }));
  assert.deepEqual(write, { ok: true, stored: false, removed: 0, dropped: 0, remaining: 1 });
  assert.deepEqual(sent.map((request) => request.url.pathname), ["/v3/memories/"]);
});

test("an add Mem0 refuses is rejected with Mem0's own sentence", async () => {
  const mem0 = fakeMem0([], (sent) =>
    sent.url.pathname === "/v3/memories/add/" ? recorded("add-bad-request.json", 400) : undefined,
  );
  const write = await against(mem0).memory.observe(items(["Uses pnpm 9"]));
  assert.equal(!write.ok && write.code, "rejected");
  assert.match(!write.ok ? write.detail : "", /^Mem0 refused an add \(400\): Invalid input data/u);
});

test("an add that times out is unavailable and is not sent twice", async () => {
  // Mistake: retrying a write that may have landed, storing it twice, either in
  // the adapter or by asking core's client for retries on it.
  const mem0 = fakeMem0([], (sent) => {
    if (sent.url.pathname !== "/v3/memories/add/") return undefined;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const { memory, sent } = against(mem0);
  const write = await memory.observe(items(["Uses pnpm 9"]));
  assert.equal(!write.ok && write.code, "unavailable");
  const adds = sent.filter((request) => request.url.pathname === "/v3/memories/add/");
  assert.deepEqual(adds.map((request) => request.retries), [0]);
});

// ---------------------------------------------------------------------------
// observe: the notebook

test("a notebook rewritten across runs comes back as exactly the last version", async () => {
  // Mistake: appending, so the agent reads v1 and v2 joined, or v1.
  const mem0 = fakeMem0();
  const { memory } = against(mem0);
  const v1 = "# Plan\n\n1. Read the code\n2. Write the tests\n";
  const v2 = "# Plan\n\n2. Write the tests\n";
  assert.equal((await memory.observe(notebook(v1, "run_1"))).ok, true);
  assert.deepEqual(await memory.observe(notebook(v2, "run_2")), { ok: true, stored: true, removed: 1, dropped: 0, remaining: 1 });
  const read = await memory.recall({ subject: TICKET, scope: NOTEBOOK });
  assert.deepEqual(read, { ok: true, held: true, entries: [{ text: v2 }], rendering: v2 });
  assert.equal(mem0.memories.length, 1);
});

test("saving an unchanged notebook keeps it, even though Mem0 dedups the add", async () => {
  // Mistake: add then delete the previous version; Mem0 drops the exact repeat,
  // so the delete removes the only copy.
  const mem0 = fakeMem0();
  const { memory, sent } = against(mem0);
  await memory.observe(notebook("# Plan\n"));
  const again = await memory.observe(notebook("# Plan\n"));
  assert.deepEqual(again, { ok: true, stored: false, removed: 0, dropped: 0, remaining: 1 });
  assert.equal(sent.filter((request) => request.method === "DELETE").length, 0);
  const read = await memory.recall({ subject: TICKET, scope: NOTEBOOK });
  assert.equal(read.ok && read.rendering, "# Plan\n");
});

test("a notebook Mem0 stores shortened is taken back out and the previous one kept", async () => {
  const mem0 = fakeMem0([
    { memory: "old notebook", user_id: TICKET.key, agent_id: "notebook/AIW-1", app_id: MEM0_NAMESPACE },
  ]);
  const long = "x".repeat(200 * 1024);
  const shortened = fakeMem0([], (sent) => {
    if (sent.url.pathname !== "/v3/memories/add/") return mem0.handle(sent, 0);
    const answer = recordedJson<{ results: { id: string; data: { memory: string } }[] }>("direct-import-add.json");
    const first = answer.results[0];
    if (first) first.data.memory = long.slice(0, 1000);
    return json({ ...answer, results: [first] });
  });
  const { memory, sent } = against(shortened);
  const write = await memory.observe(notebook(long));
  assert.equal(!write.ok && write.code, "rejected");
  assert.match(!write.ok ? write.detail : "", /stored 1000 of the notebook's 204800 bytes/u);
  const removedIds = sent.filter((request) => request.method === "DELETE").map((request) => request.url.pathname);
  assert.deepEqual(removedIds, ["/v1/memories/19d6d7aa-2454-4e58-96fc-e74d9e9f8dd1/"]);
  assert.deepEqual(mem0.memories.map((memory) => memory.memory), ["old notebook"]);
});

test("an add Mem0 only queued keeps the previous notebook rather than deleting it unconfirmed", async () => {
  const mem0 = fakeMem0(
    [{ memory: "old notebook", user_id: TICKET.key, agent_id: "notebook/AIW-1", app_id: MEM0_NAMESPACE }],
    (sent) => (sent.url.pathname === "/v3/memories/add/" ? recorded("add-pending.json") : undefined),
  );
  const { memory, sent } = against(mem0);
  const write = await memory.observe(notebook("new notebook"));
  assert.deepEqual(write, { ok: true, stored: true, removed: 0, dropped: 0, remaining: 1 });
  assert.equal(sent.filter((request) => request.method === "DELETE").length, 0);
});

test("a notebook scope refuses items, and a facts scope refuses a document", async () => {
  const { memory, sent } = against(fakeMem0());
  const wrong = await memory.observe({ ...notebook("text"), scope: FACTS });
  assert.equal(!wrong.ok && wrong.code, "rejected");
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------------------
// The admin half

test("the listing is one document per subject and scope, newest first, under the namespace only", async () => {
  const mem0 = fakeMem0([
    held("Uses pnpm 9", { created_at: "2026-09-01T00:00:00Z", metadata: { origin: "learned", runId: "run_1" } }),
    held("Tests run with vitest", { created_at: "2026-09-02T00:00:00Z", metadata: { origin: "learned", runId: "run_2" } }),
    {
      memory: "# Plan",
      user_id: TICKET.key,
      agent_id: "notebook/AIW-1",
      app_id: MEM0_NAMESPACE,
      metadata: { origin: "notebook", runId: "run_3", ticketKey: "AIW-1" },
      created_at: "2026-09-03T00:00:00Z",
    },
    { memory: "Customer is vegan", user_id: "customer_6412", agent_id: null, app_id: "support-bot" },
  ]);
  const { memory, sent } = against(mem0);
  const listing = await memory.store?.list({});
  assert.deepEqual(sent[0]?.body, { filters: { AND: [{ app_id: MEM0_NAMESPACE }] } });
  assert.equal(listing?.complete, true);
  assert.deepEqual(
    listing?.documents.map((document) => [document.subjectKey, document.docPath, document.ticketKey, document.sourceRunId]),
    [
      [TICKET.key, "notebook/AIW-1", "AIW-1", "run_3"],
      [REPO.key, "facts", null, "run_2"],
    ],
  );
  const byTicket = await memory.store?.list({ ticketKey: "AIW-1" });
  assert.deepEqual(byTicket?.documents.map((document) => document.docPath), ["notebook/AIW-1"]);
});

test("a store larger than one listing reads says it is partial", async () => {
  // Mistake: presenting the first pages as the whole store.
  const seed = Array.from({ length: 2001 }, (_, index) => held(`Fact ${index}`));
  const listing = await against(fakeMem0(seed)).memory.store?.list({});
  assert.equal(listing?.complete, false);
});

test("reading or erasing a pair list could not have produced sends nothing and answers a miss", async () => {
  // Mistake: passing `*` through to Mem0, whose delete takes it as "every".
  const mem0 = fakeMem0([held("Uses pnpm 9")]);
  const { memory, sent } = against(mem0);
  assert.equal(await memory.store?.read({ subjectKey: "*", docPath: "facts" }), null);
  assert.equal(await memory.store?.forget({ subjectKey: "*", docPath: "facts" }), false);
  assert.equal(await memory.store?.forget({ subjectKey: REPO.key, docPath: "*" }), false);
  assert.equal(await memory.store?.forget({ subjectKey: REPO.key, docPath: "everything" }), false);
  assert.equal(sent.length, 0);
  assert.equal(mem0.memories.length, 1);
});

test("erasing deletes every memory of the pair by id, and a second erase is a miss", async () => {
  const mem0 = fakeMem0([
    { memory: "v1", user_id: TICKET.key, agent_id: "notebook/AIW-1", app_id: MEM0_NAMESPACE },
    { memory: "v2", user_id: TICKET.key, agent_id: "notebook/AIW-1", app_id: MEM0_NAMESPACE },
    held("Uses pnpm 9"),
  ]);
  const { memory, sent } = against(mem0);
  const ref = { subjectKey: TICKET.key, docPath: "notebook/AIW-1" };
  assert.equal(await memory.store?.forget(ref), true);
  assert.equal(await memory.store?.read(ref), null);
  assert.equal(await memory.store?.forget(ref), false);
  assert.deepEqual(mem0.memories.map((stored) => stored.memory), ["Uses pnpm 9"]);
  // Never the filter delete, which runs in the background and takes wildcards.
  assert.equal(sent.some((request) => request.method === "DELETE" && request.url.pathname === "/v1/memories/"), false);
});

test("the admin half throws what it could not read instead of answering an empty store", async () => {
  const { ctx } = mem0Answering(() => undocumented.unavailable());
  await assert.rejects(mem0Memory(ctx).store?.list({}) ?? Promise.resolve(), /did not complete a listing \(503\)/u);
});

test("Mem0's own words are quoted without the key, even when Mem0 echoes it", async () => {
  // Mistake: quoting a refusal body as it came. The detail reaches core's
  // logger, which does not know this integration's key. The body is the
  // documented 400 with its message changed to echo the key, which Mem0 is
  // not documented to do; it is the worst case the quote has to survive.
  const echoed = recordedJson<{ error: string; details: { message: string } }>("add-bad-request.json");
  echoed.details.message = `Invalid header: Token ${FAKE_KEY}`;
  const mem0 = fakeMem0([], (sent) => (sent.url.pathname === "/v3/memories/add/" ? json(echoed, 400) : undefined));
  const write = await against(mem0).memory.observe(items(["Uses pnpm 9"]));
  assert.equal(!write.ok && write.code, "rejected");
  assert.match(!write.ok ? write.detail : "", /Invalid header: Token \[REDACTED\]/u);
  assert.equal(JSON.stringify(write).includes(FAKE_KEY), false);
});

test("a 403 about the plan is not read as a refused key", async () => {
  // Composed: Mem0 documents `upgrade_required: true` on plan-gated 403s
  // (openapi.json, the dream endpoints); what a spent monthly quota answers is
  // not documented.
  const { memory } = mem0AnsweringWith(json({ detail: "Upgrade required", upgrade_required: true }, 403));
  const read = await memory.recall({ subject: REPO, scope: FACTS });
  assert.equal(!read.ok && read.code, "unavailable");
  assert.match(!read.ok ? read.detail : "", /plan \(403, upgrade required\)/u);
});

// ---------------------------------------------------------------------------
// How much one subject holds

function learnedAt(text: string, day: number, origin = "learned"): Partial<FakeMemory> {
  const at = new Date(Date.UTC(2026, 0, day)).toISOString();
  return held(text, { created_at: at, updated_at: at, metadata: { origin } });
}

test("an add past the limit forgets the oldest learned facts, never a derived one", async () => {
  // Mistake: never evicting, so a repository's facts grow with every run
  // until every observe refuses.
  const seed = [learnedAt("Package manager: pnpm", 1, "derived"), ...Array.from({ length: 39 }, (_, i) => learnedAt(`Fact ${i}`, i + 2))];
  const mem0 = fakeMem0(seed);
  const write = await against(mem0).memory.observe(items(["New A", "New B", "New C"]));
  assert.deepEqual(write, { ok: true, stored: true, removed: 0, dropped: 3, remaining: 40 });
  const texts = mem0.memories.map((memory) => memory.memory);
  assert.equal(texts.length, 40);
  assert.ok(texts.includes("Package manager: pnpm"));
  for (const gone of ["Fact 0", "Fact 1", "Fact 2"]) assert.equal(texts.includes(gone), false, gone);
  assert.ok(texts.includes("Fact 3") && texts.includes("New C"));
});

test("lessons keep their own, smaller limit", async () => {
  const seed = Array.from({ length: 30 }, (_, i) => Object.assign(learnedAt(`Lesson ${i}`, i + 1), { agent_id: "lessons" }));
  const mem0 = fakeMem0(seed);
  const write = await against(mem0).memory.observe({ ...items(["New lesson"]), scope: { kind: "lessons" } });
  assert.deepEqual(write, { ok: true, stored: true, removed: 0, dropped: 1, remaining: 30 });
});

test("a pure retraction never trims, even past the limit", async () => {
  const seed = Array.from({ length: 45 }, (_, i) => learnedAt(`Fact ${i}`, i + 1));
  const mem0 = fakeMem0(seed);
  const write = await against(mem0).memory.observe(items([], ["Fact 44"]));
  assert.deepEqual(write, { ok: true, stored: true, removed: 1, dropped: 0, remaining: 44 });
});

test("a seed on a subject too full to reconcile answers stored: false, not a refusal", async () => {
  const seed = Array.from({ length: 1001 }, (_, i) => held(`Fact ${i}`));
  const write = await against(fakeMem0(seed)).memory.observe(
    items(["Package manager: pnpm"], [], { derived: true, onlyIfEmpty: true }),
  );
  assert.deepEqual(write, { ok: true, stored: false, removed: 0, dropped: 0, remaining: 1000 });
});

// ---------------------------------------------------------------------------
// What an add answered

test("an add Mem0 reports as FAILED stored nothing", async () => {
  // Mistake: reading any 200 as stored. The body is composed: `FAILED` is one
  // of the documented values of `status` (openapi.json, POST /v3/memories/add/).
  const mem0 = fakeMem0([], (sent) =>
    sent.url.pathname === "/v3/memories/add/" ? json({ event_id: "evt-uuid", status: "FAILED" }) : undefined,
  );
  const write = await against(mem0).memory.observe(items(["Uses pnpm 9"]));
  assert.deepEqual(write, { ok: false, code: "unavailable", detail: "Mem0 reported the add as FAILED, so nothing was stored." });
});

test("an add answered with no results stored nothing, unlike one only queued", async () => {
  const empty = (sent: { url: URL }) =>
    sent.url.pathname === "/v3/memories/add/"
      ? json({ ...recordedJson<Record<string, unknown>>("direct-import-add.json"), results: [] })
      : undefined;
  const items0 = await against(fakeMem0([], empty)).memory.observe(items(["Uses pnpm 9"]));
  assert.deepEqual(items0, { ok: true, stored: false, removed: 0, dropped: 0, remaining: 0 });
  const mem0 = fakeMem0(
    [{ memory: "old notebook", user_id: TICKET.key, agent_id: "notebook/AIW-1", app_id: MEM0_NAMESPACE }],
    empty,
  );
  const { memory, sent } = against(mem0);
  const write = await memory.observe(notebook("new notebook"));
  assert.equal(!write.ok && write.code, "unavailable");
  assert.equal(sent.filter((request) => request.method === "DELETE").length, 0);
});

// ---------------------------------------------------------------------------
// The memory screen shows what a prompt carries

test("Mem0's own documented listing is reported partial, never as an empty store", async () => {
  // Mistake: skipping memories this integration cannot address and still
  // answering complete. The recorded get-all answer carries no entity fields.
  const { memory } = mem0AnsweringWith(recorded("get-memories.json"));
  const listing = await memory.store?.list({});
  assert.deepEqual(listing, { documents: [], complete: false });
});

test("the memory screen's content is exactly what recall renders", async () => {
  const mem0 = fakeMem0([
    learnedAt("Flaky test in auth suite", 5),
    learnedAt("Package manager: pnpm", 1, "derived"),
    learnedAt("Uses vitest", 3),
  ]);
  const { memory } = against(mem0);
  const read = await memory.recall({ subject: REPO, scope: FACTS });
  const shown = await memory.store?.read({ subjectKey: REPO.key, docPath: "facts" });
  assert.equal(shown?.content, read.ok ? read.rendering : "not ok");
});

/** A Mem0 that answers every request with one response. */
function mem0AnsweringWith(response: Response) {
  const double = mem0Answering(() => response.clone());
  return { memory: mem0Memory(double.ctx), ...double };
}
