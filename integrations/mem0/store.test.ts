/**
 * The memory store on Mem0 (`store.ts`), version 2 of the memory port.
 *
 * First the port's own conformance suite against the fake of the live
 * platform (`store-test-support.ts`), then what the suite cannot see: each
 * status Mem0 answers and how it reaches core, a queued add, `replaced_by`,
 * `delete_linked`, pagination past one page, the update paths, and the
 * identity a run pins. Recorded bodies are Mem0's own (`test-fixtures/live-*`,
 * from the live probe on 2026-09-25); a status Mem0 never sent the probe is a
 * bare status, which proves only how it is read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMemoryStoreConformance,
  memoryTextHash,
  type MemoryStore,
  type MemoryStoreApplyRequest,
  type MemoryStoreConformanceHarness,
} from "@integrations/sdk";
import { MEM0_NAMESPACE } from "./memory";
import { mem0MemoryStore, readMem0Identity } from "./store";
import { fakeMem0Platform, type FakePlatform } from "./store-test-support";
import { FAKE_KEY, json, mem0Answering, recorded, recordedJson, undocumented, type Sent } from "./test-support";

const REPO = "repo:github:acme/api";

const platforms = new WeakMap<MemoryStore, FakePlatform>();

function storeOn(platform: FakePlatform, override?: (sent: Sent, index: number) => Response | undefined) {
  const double = mem0Answering((sent, index) => override?.(sent, index) ?? platform.handle(sent));
  const store = mem0MemoryStore(double.ctx);
  platforms.set(store, platform);
  return { store, platform, ...double };
}

function platformOf(store: MemoryStore): FakePlatform {
  const platform = platforms.get(store);
  assert.ok(platform, "a store opened by this harness");
  return platform;
}

function applying(change: Partial<MemoryStoreApplyRequest>): MemoryStoreApplyRequest {
  return { subject: REPO, kind: "facts", add: [], update: [], remove: [], ...change };
}

let written = Date.parse("2026-09-01T00:00:00.000Z");

/** A memory as this store writes it (a later `addedAt` than the one before), stored straight into the fake. */
function ours(platform: FakePlatform, text: string, extra: Record<string, unknown> = {}) {
  return platform.seed({
    memory: text,
    user_id: REPO,
    agent_id: "facts",
    app_id: MEM0_NAMESPACE,
    metadata: { origin: "learned", addedAt: new Date((written += 1)).toISOString(), ...extra },
  });
}

function calls(sent: readonly Sent[]): string[] {
  return sent.map((request) => `${request.method} ${request.url.pathname}${request.url.search}`);
}

/** How fetch fails when the request got no answer: a TypeError whose cause carries the system's or undici's code. */
function connectionFailure(message: string, code?: string): TypeError {
  return new TypeError(message, code === undefined ? undefined : { cause: Object.assign(new Error(`${code} (test)`), { code }) });
}

function timedOut(): Error {
  return Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
}

function listings(sent: readonly Sent[]): Sent[] {
  return sent.filter((request) => request.url.pathname === "/v3/memories/");
}

// ---------------------------------------------------------------------------
// The port's conformance suite

test("the store passes the memory store conformance suite against the fake of Mem0, queueing and consolidation included", async () => {
  // Mistake that turns this red: any break of the port's promises, for
  // example reading one page of a listing (held_complete at 205), ordering by
  // Mem0's created_at alone (held_order: it is listed to the second), or
  // answering an id for a queued add (apply_pending).
  const harness: MemoryStoreConformanceHarness = {
    open: () => storeOn(fakeMem0Platform()).store,
    openUnreachable: () =>
      mem0MemoryStore(
        mem0Answering(() => {
          throw connectionFailure("fetch failed", "ECONNREFUSED");
        }).ctx,
      ),
    consolidate: async (store) => platformOf(store).consolidate(),
    openQueueing: () => storeOn(fakeMem0Platform({ queueing: true })).store,
    settle: async (store) => platformOf(store).settle(),
  };
  const issues = await checkMemoryStoreConformance(harness);
  assert.deepEqual(issues, []);
});

test("the store declares that Mem0 consolidates and that protect proves nothing", () => {
  // Mistake: promising core that Mem0 holds exactly what apply left (it
  // documents Supersede and Merge on every add), or that immutable protects
  // (the probe saw it change nothing).
  assert.deepEqual(storeOn(fakeMem0Platform()).store.traits, { consolidates: true, protects: false });
});

// ---------------------------------------------------------------------------
// Statuses, as core reads them

const members: readonly [string, (store: MemoryStore) => Promise<unknown>][] = [
  ["recall", (store) => store.recall({ subjects: [REPO], kinds: ["facts"], query: "ports" })],
  ["held", (store) => store.held({ subject: REPO, kind: "facts" })],
  // A removal reads what the subject holds first, so the refusal comes before any write.
  ["apply", (store) => store.apply(applying({ remove: [{ id: "00000000-0000-4000-8000-000000000001", reason: "cap" }] }))],
  ["forget", (store) => store.forget({ subject: REPO })],
  ["list", (store) => store.list()],
];

const statuses: readonly { name: string; answer: () => Response; reason?: string; code: string; status: number; says: RegExp }[] = [
  { name: "401 (live body)", answer: () => recorded("live-unauthorized.json", 401), code: "unavailable", reason: "key_rejected", status: 401, says: /refused the API key/u },
  { name: "403", answer: () => json({ detail: "Forbidden" }, 403), code: "unavailable", reason: "key_rejected", status: 403, says: /refused the API key/u },
  { name: "403 upgrade_required", answer: () => json({ detail: "Upgrade required", upgrade_required: true }, 403), code: "unavailable", reason: "quota", status: 403, says: /plan/u },
  { name: "413", answer: () => new Response("", { status: 413 }), code: "unavailable", reason: "quota", status: 413, says: /quota/u },
  { name: "429", answer: () => undocumented.rateLimited("30"), code: "unavailable", reason: "rate_limited", status: 429, says: /rate limited .*30 s/u },
  { name: "503", answer: () => undocumented.unavailable(), code: "unavailable", status: 503, says: /did not complete .*503/u },
  { name: "502 page", answer: () => undocumented.gatewayPage(), code: "unavailable", status: 502, says: /did not complete .*502/u },
  { name: "400", answer: () => json({ error: "Validation error", details: { message: "filters is invalid" } }, 400), code: "rejected", status: 400, says: /refused .*400.*filters is invalid/u },
];

for (const row of statuses) {
  test(`Mem0 answering ${row.name} reaches core as ${row.code}${row.reason ? ` ${row.reason}` : ""} with the status, from every member`, async () => {
    // Mistake: a refused key read as "try again" with no reason, a quota or a
    // rate limit that core cannot tell apart, or a status that is lost.
    for (const [member, call] of members) {
      const { store, logs } = storeOn(fakeMem0Platform(), () => row.answer());
      const answer = (await call(store)) as Record<string, unknown>;
      assert.equal(answer.ok, false, member);
      assert.equal(answer.code, row.code, member);
      assert.equal(answer.reason, row.reason, member);
      assert.equal(answer.status, row.status, member);
      assert.match(String(answer.detail), row.says, member);
      assert.doesNotMatch(JSON.stringify([answer, logs]), new RegExp(FAKE_KEY, "u"), member);
      assert.doesNotMatch(String(answer.detail), /<html/u, member);
    }
  });
}

test("a timeout answers unavailable with reason timeout, and the rest of the step does not ask Mem0 again", async () => {
  // Mistake: every later call spending its own attempt on a Mem0 that hangs.
  const { store, sent } = storeOn(fakeMem0Platform(), () => {
    throw timedOut();
  });
  const first = await store.held({ subject: REPO, kind: "facts" });
  const second = await store.recall({ subjects: [REPO], kinds: ["facts"] });
  assert.deepEqual(first, { ok: false, code: "unavailable", detail: "Mem0 did not answer within 10 s.", reason: "timeout" });
  assert.equal(second.ok === false && second.reason, "timeout");
  assert.equal(sent.length, 1);
});

test("a connection that was never made answers unavailable with reason unreachable; one that broke later is not called unreachable", async () => {
  const refused = storeOn(fakeMem0Platform(), () => {
    throw connectionFailure("fetch failed", "ECONNREFUSED");
  });
  assert.deepEqual(await refused.store.list(), { ok: false, code: "unavailable", detail: "Mem0 could not be reached.", reason: "unreachable" });
  const cut = storeOn(fakeMem0Platform(), () => {
    throw connectionFailure("terminated", "UND_ERR_SOCKET");
  });
  assert.deepEqual(await cut.store.list(), { ok: false, code: "unavailable", detail: "The connection to Mem0 broke before its answer came back." });
});

const NEVER_CONNECTED = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"];

test("an add that failed before any connection was made refuses the apply as unreachable, since nothing can have landed", async () => {
  for (const code of NEVER_CONNECTED) {
    const { store } = storeOn(fakeMem0Platform(), () => {
      throw connectionFailure("fetch failed", code);
    });
    const answer = await store.apply(applying({ add: [{ text: "The API listens on port 3000.", origin: "learned" }] }));
    assert.deepEqual(answer, { ok: false, code: "unavailable", detail: "Mem0 could not be reached.", reason: "unreachable" }, code);
  }
});

test("an add whose connection broke any other way is a failed item whose fate is unknown, never a refusal saying nothing landed", async () => {
  // Mistake: a body cut short (ctx.http rethrows it as a TypeError) or a reset
  // after the request left, read as unreachable, so core records that nothing
  // landed while Mem0 may hold the text.
  const thrown: readonly [string, () => Error][] = [
    ["a body cut short", () => connectionFailure("terminated", "UND_ERR_SOCKET")],
    ["a reset", () => connectionFailure("fetch failed", "ECONNRESET")],
    ["no cause at all", () => connectionFailure("fetch failed")],
  ];
  for (const [what, error] of thrown) {
    const { store } = storeOn(fakeMem0Platform(), () => {
      throw error();
    });
    const answer = await store.apply(applying({ add: [{ text: "The API listens on port 3000.", origin: "learned" }] }));
    assert.deepEqual(
      answer.ok && answer.outcomes,
      [
        {
          op: "add",
          index: 0,
          result: "failed",
          code: "unavailable",
          detail: "The connection to Mem0 broke before its answer came back, so whether the write landed is not known.",
        },
      ],
      what,
    );
  }
});

test("once core's memory time for the step ran out, nothing is sent and every member answers timeout", async () => {
  const platform = fakeMem0Platform();
  const aborted = new AbortController();
  aborted.abort();
  const double = mem0Answering((sent) => platform.handle(sent));
  const store = mem0MemoryStore({ ...double.ctx, signal: aborted.signal });
  const answer = await store.held({ subject: REPO, kind: "facts" });
  assert.equal(answer.ok === false && answer.reason, "timeout");
  assert.equal(double.sent.length, 0);
});

test("an add whose answer never came back is a failed item whose fate is unknown, not a refusal saying nothing landed", async () => {
  // Mistake: a refusal tells core nothing was written, and Mem0 may have
  // stored the text before the answer was lost.
  const { store } = storeOn(fakeMem0Platform(), (sent) =>
    sent.url.pathname === "/v3/memories/add/" ? undocumented.unavailable() : undefined,
  );
  const answer = await store.apply(applying({ add: [{ text: "The API listens on port 3000.", origin: "learned" }] }));
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.ok && answer.outcomes, [
    { op: "add", index: 0, result: "failed", code: "unavailable", detail: "Mem0 did not complete an add (503).", status: 503 },
  ]);
});

// ---------------------------------------------------------------------------
// What an add sends and answers

test("an add is a Direct Import that stamps origin, run, ticket and addedAt, never immutable, and answers the ids Mem0 gave", async () => {
  // Mistake: sending infer true (Mem0 would reword and queue), sending
  // immutable (the probe decided against it), or losing the provenance.
  const { store, sent, platform } = storeOn(fakeMem0Platform());
  const answer = await store.apply(
    applying({
      runId: "run_1",
      ticketKey: "AIW-1",
      add: [
        { text: "The API listens on port 3000.", origin: "learned", protect: true },
        { text: "Tests run with vitest.", origin: "learned" },
      ],
    }),
  );
  const add = sent.find((request) => request.url.pathname === "/v3/memories/add/");
  const body = add?.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["agent_id", "app_id", "infer", "messages", "metadata", "user_id"]);
  assert.equal(body.infer, false);
  assert.equal(body.user_id, REPO);
  assert.equal(body.agent_id, "facts");
  assert.equal(body.app_id, MEM0_NAMESPACE);
  const metadata = body.metadata as Record<string, string>;
  assert.deepEqual({ ...metadata, addedAt: "" }, { origin: "learned", runId: "run_1", ticketKey: "AIW-1", addedAt: "" });
  assert.ok(Number.isFinite(Date.parse(metadata.addedAt ?? "")));
  assert.deepEqual(answer.ok && answer.outcomes, [
    { op: "add", index: 0, result: "added", id: platform.memories[0]?.id },
    { op: "add", index: 1, result: "added", id: platform.memories[1]?.id },
  ]);
});

test("Mem0's live answer to a Direct Import maps each text to its id, the exact repeat to the memory already holding it", async () => {
  // The recorded answer: three texts, the second already held, whose id Mem0
  // answered in its place.
  const live = recordedJson<{ results: { id: string; data: { memory: string } }[] }>("live-add-direct-import.json");
  const texts = live.results.map((result) => result.data.memory);
  const { store } = storeOn(fakeMem0Platform(), (request) =>
    request.url.pathname === "/v3/memories/add/" ? recorded("live-add-direct-import.json") : undefined,
  );
  const answer = await store.apply(applying({ add: texts.map((text) => ({ text, origin: "learned" as const })) }));
  assert.deepEqual(
    answer.ok && answer.outcomes,
    live.results.map((result, index) => ({ op: "add", index, result: "added", id: result.id })),
  );
});

test("a queued add answers pending with no id, and the event id goes to the log", async () => {
  // Mistake: answering the event id, or an id nobody holds, as the entry's.
  const { store, logs } = storeOn(fakeMem0Platform(), (request) =>
    request.url.pathname === "/v3/memories/add/" ? recorded("live-add-queued.json") : undefined,
  );
  const answer = await store.apply(applying({ add: [{ text: "My API service listens on port 3000.", origin: "learned" }] }));
  assert.deepEqual(answer.ok && answer.outcomes, [{ op: "add", index: 0, result: "pending" }]);
  assert.deepEqual(
    logs.map((line) => [line.event, line.fields]),
    [["mem0_add_queued", { eventId: recordedJson<{ event_id: string }>("live-add-queued.json").event_id, items: 1 }]],
  );
});

test("an add Mem0 answered without the text is a failed item, never an id taken from another result", async () => {
  const { store } = storeOn(fakeMem0Platform(), (request) =>
    request.url.pathname === "/v3/memories/add/"
      ? json({ status: "SUCCEEDED", results: [{ id: "someone-else", data: { memory: "Another text." }, event: "ADD" }] })
      : undefined,
  );
  const answer = await store.apply(applying({ add: [{ text: "The API listens on port 3000.", origin: "learned" }] }));
  const [outcome] = answer.ok ? answer.outcomes : [];
  assert.equal(outcome?.result, "failed");
  assert.equal(outcome?.result === "failed" && outcome.code, "unavailable");
});

test("an add Mem0 answered with neither PENDING nor results is a failed item whose fate is unknown, never pending", async () => {
  // Mistake: pending tells core the text is queued and will land; an answer
  // that says nothing of the kind promises nothing.
  for (const body of [{}, { message: "Memories stored successfully" }, { status: "SUCCEEDED" }]) {
    const { store } = storeOn(fakeMem0Platform(), (request) => (request.url.pathname === "/v3/memories/add/" ? json(body) : undefined));
    const answer = await store.apply(applying({ add: [{ text: "The API listens on port 3000.", origin: "learned" }] }));
    const [outcome] = answer.ok ? answer.outcomes : [];
    assert.equal(outcome?.result === "failed" && outcome.code, "unavailable", JSON.stringify(body));
  }
});

test("an apply whose items failed for different causes answers each item, not one refusal in the first one's words", async () => {
  // Mistake: a bad request on one batch and a rate limit on the other answered
  // as one rejected refusal, so core would never ask again for the texts
  // that were only rate limited.
  const { store } = storeOn(fakeMem0Platform(), (request) => {
    if (request.url.pathname !== "/v3/memories/add/") return undefined;
    const { origin } = (request.body as { metadata: { origin: string } }).metadata;
    return origin === "learned" ? json({ error: "Validation error", details: { message: "text is too long" } }, 400) : undocumented.rateLimited();
  });
  const answer = await store.apply(
    applying({ add: [{ text: "The API listens on port 3000.", origin: "learned" }, { text: "Deploys go out on Tuesdays.", origin: "derived" }] }),
  );
  assert.deepEqual(answer.ok && answer.outcomes, [
    { op: "add", index: 0, result: "failed", code: "rejected", detail: "Mem0 refused an add (400): text is too long.", status: 400 },
    { op: "add", index: 1, result: "failed", code: "unavailable", detail: "Mem0 rate limited an add (429).", reason: "rate_limited", status: 429 },
  ]);
});

test("an apply whose items all failed for one cause, none of which can have landed, is one refusal with that cause", async () => {
  const { store } = storeOn(fakeMem0Platform(), (request) => (request.url.pathname === "/v3/memories/add/" ? undocumented.rateLimited("30") : undefined));
  const answer = await store.apply(
    applying({ add: [{ text: "The API listens on port 3000.", origin: "learned" }, { text: "Deploys go out on Tuesdays.", origin: "derived" }] }),
  );
  assert.deepEqual(answer, { ok: false, code: "unavailable", detail: "Mem0 rate limited an add (429); it asked to wait 30 s.", reason: "rate_limited", status: 429 });
});

test("an add Mem0 refuses as a bad request refuses the apply as rejected with the status, since nothing landed", async () => {
  const { store } = storeOn(fakeMem0Platform(), (request) =>
    request.url.pathname === "/v3/memories/add/" ? json({ error: "Validation error", details: { message: "messages is required" } }, 400) : undefined,
  );
  const answer = await store.apply(applying({ add: [{ text: "", origin: "learned" }] }));
  assert.deepEqual(answer, { ok: false, code: "rejected", detail: "Mem0 refused an add (400): messages is required.", status: 400 });
});

// ---------------------------------------------------------------------------
// Reading: pagination, order, replaced_by, namespace

test("held reads every page to 205 memories, oldest first by addedAt, though Mem0 lists them to the second and out of order", async () => {
  // Mistake: one page of 200, or ordering by created_at, which the listing
  // gives to the second: all 205 here share one second.
  const platform = fakeMem0Platform();
  const texts = Array.from({ length: 205 }, (_, index) => `Service ${index + 1} listens on port ${3000 + index + 1}.`);
  texts.forEach((text, index) => ours(platform, text, { addedAt: new Date(Date.UTC(2026, 8, 25, 9, 0, 0, index)).toISOString() }));
  const { store, sent } = storeOn(platform);
  const held = await store.held({ subject: REPO, kind: "facts" });
  assert.deepEqual(held.ok && held.entries.map((entry) => entry.text), texts);
  assert.deepEqual(calls(sent), ["POST /v3/memories/?page=1&page_size=200", "POST /v3/memories/?page=2&page_size=200"]);
});

test("a listing that changed between two of its pages is refused, whether a memory was added or deleted, since one may have been skipped", async () => {
  // Mistake: checking only that the pages add up to Mem0's final count, which
  // a delete keeps true: every later memory moves one place up, one passes onto
  // a page already read, and held answers without it. Re-reading page 1 would
  // not see the third case either.
  const cases: readonly { what: string; size: number; page: number; change: (platform: FakePlatform, order: readonly string[]) => void }[] = [
    { what: "an add before page 2", size: 250, page: 2, change: (platform) => ours(platform, "A fact another run wrote meanwhile.") },
    { what: "a delete on page 1 before page 2", size: 250, page: 2, change: (platform, order) => deleteFrom(platform, order[0]) },
    { what: "a delete on page 2 before page 3", size: 450, page: 3, change: (platform, order) => deleteFrom(platform, order[250]) },
  ];
  for (const { what, size, page, change } of cases) {
    const platform = fakeMem0Platform();
    for (let index = 1; index <= size; index += 1) ours(platform, `Service ${index} listens on port ${3000 + index}.`);
    // Every one was written within one second, which the fake lists by text.
    const order = platform.memories.map((memory) => memory.memory).sort((a, b) => a.localeCompare(b));
    let changed = false;
    const { store } = storeOn(platform, (request) => {
      if (!changed && request.url.pathname === "/v3/memories/" && request.url.searchParams.get("page") === String(page)) {
        changed = true;
        change(platform, order);
      }
      return undefined;
    });
    const held = await store.held({ subject: REPO, kind: "facts" });
    assert.deepEqual(held, { ok: false, code: "unavailable", detail: "Mem0's listing changed while it was read; ask again." }, what);
  }
});

function deleteFrom(platform: FakePlatform, text: string | undefined): void {
  const at = platform.memories.findIndex((memory) => memory.memory === text);
  assert.ok(at >= 0, `the fake holds ${text}`);
  platform.memories.splice(at, 1);
}

test("past ten pages (2,000 memories) held refuses rather than answering part of the set, and list answers what it read as incomplete", async () => {
  // Mistake: a held that answered the first 2,000 as everything, so core
  // would evict or dedup against a set it has not seen; or a list that said
  // it was complete.
  const platform = fakeMem0Platform();
  for (let index = 1; index <= 2001; index += 1) ours(platform, `Service ${index} listens on port ${index}.`);
  const { store, sent } = storeOn(platform);
  const held = await store.held({ subject: REPO, kind: "facts" });
  assert.equal(held.ok === false && held.code, "rejected");
  assert.equal(sent.length, 10);
  const listed = await store.list();
  assert.deepEqual(listed.ok && [listed.complete, listed.holdings.map((holding) => [holding.subject, holding.kind, holding.entries])], [false, [[REPO, "facts", 2000]]]);
});

test("a ranked recall reads the complete set and searches it once with threshold 0 and top_k as large as the set", async () => {
  const platform = fakeMem0Platform();
  for (let index = 1; index <= 205; index += 1) ours(platform, `Service ${index} listens on port ${3000 + index}.`);
  const { store, sent } = storeOn(platform);
  const answer = await store.recall({ subjects: [REPO], kinds: ["facts", "lessons"], query: "Which port does service 7 listen on?" });
  assert.equal(answer.ok && answer.ranked, true);
  assert.equal(answer.ok ? answer.entries.length : "refused", 205);
  const search = sent.find((request) => request.url.pathname === "/v3/memories/search/");
  assert.deepEqual(search?.body, {
    query: "Which port does service 7 listen on?",
    filters: { AND: [{ app_id: MEM0_NAMESPACE }, { user_id: REPO }, { agent_id: { in: ["facts", "lessons"] } }] },
    top_k: 205,
    threshold: 0,
    rerank: false,
  });
  assert.equal(calls(sent).length, 3);
});

test("a recall whose search Mem0 refused still answers the complete set, unranked", async () => {
  // Mistake: refusing the whole recall, so the agent gets no memory at all
  // because ranking, which only orders, failed.
  const platform = fakeMem0Platform();
  ours(platform, "The API listens on port 3000.");
  const { store, logs } = storeOn(platform, (request) => (request.url.pathname === "/v3/memories/search/" ? undocumented.rateLimited() : undefined));
  const answer = await store.recall({ subjects: [REPO], kinds: ["facts"], query: "ports" });
  assert.deepEqual(answer.ok && [answer.ranked, answer.entries.map((entry) => entry.text)], [false, ["The API listens on port 3000."]]);
  assert.deepEqual(logs.map((line) => line.event), ["mem0_recall_search_unavailable"]);
});

test("replaced_by reaches core as replacedBy only while the memory it names is held beside it", async () => {
  // Mistake: an entry superseded by one that has since been deleted stays
  // hidden from every prompt forever.
  const platform = fakeMem0Platform();
  const older = ours(platform, "The API listens on port 3000.");
  const newer = ours(platform, "The API listens on port 3001.");
  const orphan = ours(platform, "Tests run with jest.");
  older.replaced_by = newer.id;
  orphan.replaced_by = "a-memory-no-longer-held";
  const held = await storeOn(platform).store.held({ subject: REPO, kind: "facts" });
  assert.deepEqual(
    held.ok && held.entries.map((entry) => [entry.text, entry.replacedBy]),
    [
      ["The API listens on port 3000.", newer.id],
      ["The API listens on port 3001.", undefined],
      ["Tests run with jest.", undefined],
    ],
  );
});

test("a listing Mem0 answered with memories of another application or subject is read as not ours", async () => {
  // Mistake: trusting Mem0's filter alone, so a looser match reaches a prompt.
  const platform = fakeMem0Platform();
  ours(platform, "The API listens on port 3000.");
  const { store } = storeOn(platform, (request) => {
    if (request.url.pathname !== "/v3/memories/") return undefined;
    const page = recordedJson<{ results: Record<string, unknown>[] }>("live-list-page.json");
    const [record] = page.results;
    return json({
      count: 3,
      next: null,
      previous: null,
      results: [
        { ...record, id: "ours", memory: "The API listens on port 3000.", user_id: REPO, app_id: MEM0_NAMESPACE, metadata: { origin: "learned" } },
        { ...record, id: "chatbot", memory: "Alice likes tea.", user_id: REPO, app_id: "chatbot" },
        { ...record, id: "upper", memory: "Another subject.", user_id: "repo:github:ACME/api", app_id: MEM0_NAMESPACE },
      ],
    });
  });
  const held = await store.held({ subject: REPO, kind: "facts" });
  assert.deepEqual(held.ok && held.entries.map((entry) => entry.id), ["ours"]);
});

test("a subject holding * or % is refused as rejected by every member, and nothing is sent", async () => {
  // Mistake: Mem0 reads a bare * as any value, and does not say % is not a
  // pattern. The fake reads % as an ordinary character, so only the store's
  // own check keeps such a subject from reaching Mem0.
  for (const subject of ["repo:github:acme/*", "repo:github:acme/100%"]) {
    const { store, sent } = storeOn(fakeMem0Platform());
    const answers = [
      await store.recall({ subjects: [subject], kinds: ["facts"] }),
      await store.held({ subject, kind: "facts" }),
      await store.apply(applying({ subject, add: [{ text: "The API listens on port 3000.", origin: "learned" }] })),
      await store.forget({ subject }),
    ];
    assert.deepEqual(answers.map((answer) => answer.ok === false && answer.code), ["rejected", "rejected", "rejected", "rejected"], subject);
    assert.equal(sent.length, 0, subject);
  }
});

test("a removal or an update of an id this subject does not hold is missing, and nothing is sent to delete or change it", async () => {
  // Mistake: deleting by id what another subject or application holds.
  const platform = fakeMem0Platform();
  const elsewhere = platform.seed({ memory: "Alice likes tea.", user_id: REPO, agent_id: "facts", app_id: "chatbot" });
  const { store, sent } = storeOn(platform);
  const answer = await store.apply(applying({ remove: [{ id: elsewhere.id, reason: "forgotten" }], update: [{ id: elsewhere.id, text: "Alice likes coffee." }] }));
  assert.deepEqual(answer.ok && answer.outcomes, [
    { op: "remove", index: 0, result: "missing", id: elsewhere.id },
    { op: "update", index: 0, result: "missing", id: elsewhere.id },
  ]);
  assert.deepEqual(calls(sent), ["POST /v3/memories/?page=1&page_size=200"]);
  assert.equal(platform.memories[0]?.memory, "Alice likes tea.");
});

test("two runs applying to one subject at once, one evicting for the cap, both land whole (plan case E16)", async () => {
  // Mistake: an apply that reads what is held, then writes the set back,
  // would drop the other run's addition.
  const platform = fakeMem0Platform();
  const oldest = ours(platform, "The API used Node 18.");
  ours(platform, "The API listens on port 3000.");
  const { store } = storeOn(platform);
  const [first, second] = await Promise.all([
    store.apply(applying({ runId: "run_a", add: [{ text: "Deploys go out on Tuesdays.", origin: "learned" }] })),
    store.apply(applying({ runId: "run_b", remove: [{ id: oldest.id, reason: "cap" }], add: [{ text: "Tests run with vitest.", origin: "learned" }] })),
  ]);
  assert.deepEqual([first.ok, second.ok], [true, true]);
  const held = await store.held({ subject: REPO, kind: "facts" });
  assert.deepEqual(held.ok && held.entries.map((entry) => entry.text).sort(), [
    "Deploys go out on Tuesdays.",
    "Tests run with vitest.",
    "The API listens on port 3000.",
  ]);
});

// ---------------------------------------------------------------------------
// Updates

test("an update is a PUT that keeps the id, the origin and the entry's place, and stamps the later run", async () => {
  // Mistake: PUT replaces the whole metadata (seen live), so an update that
  // sent only the run would turn a derived fact into one of unknown origin.
  const platform = fakeMem0Platform();
  const entry = ours(platform, "The API uses Postgres 15.", { origin: "derived", runId: "run_1", ticketKey: "AIW-1", addedAt: "2026-09-01T00:00:00.000Z" });
  const { store, sent } = storeOn(platform);
  const answer = await store.apply(applying({ runId: "run_2", update: [{ id: entry.id, text: "The API uses Postgres 16." }] }));
  assert.deepEqual(answer.ok && answer.outcomes, [{ op: "update", index: 0, result: "updated", previousId: entry.id, id: entry.id }]);
  const put = sent.find((request) => request.method === "PUT");
  assert.deepEqual(put?.body, { text: "The API uses Postgres 16.", metadata: { origin: "derived", addedAt: "2026-09-01T00:00:00.000Z", runId: "run_2" } });
});

test("an update whose PUT Mem0 did not complete (a 503, or no answer in time) is a failed item, and nothing is added or deleted", async () => {
  // Mistake: replacing an entry whose PUT may have landed: only a PUT Mem0
  // refused as a bad request is replaced, or the entry is lost or doubled.
  const cases: readonly [string, () => Response, Record<string, unknown>][] = [
    ["a 503", () => undocumented.unavailable(), { detail: "Mem0 did not complete an update (503).", status: 503 }],
    [
      "a timeout",
      () => {
        throw timedOut();
      },
      { detail: "Mem0 did not answer within 10 s.", reason: "timeout" },
    ],
  ];
  for (const [what, answer, expected] of cases) {
    const platform = fakeMem0Platform();
    const entry = ours(platform, "Deploys go out on Tuesdays.");
    const { store, sent } = storeOn(platform, (request) => (request.method === "PUT" ? answer() : undefined));
    const applied = await store.apply(applying({ update: [{ id: entry.id, text: "Deploys go out on Thursdays." }] }));
    assert.deepEqual(applied.ok && applied.outcomes, [{ op: "update", index: 0, result: "failed", code: "unavailable", ...expected }], what);
    assert.deepEqual(calls(sent).slice(1), [`PUT /v1/memories/${entry.id}/`], what);
    assert.deepEqual(platform.memories.map((memory) => memory.memory), ["Deploys go out on Tuesdays."], what);
  }
});

test("an update Mem0 will not make in place is replaced: the new text added first, the old entry deleted second, ids chained", async () => {
  // D6: an immutable memory is updated by delete plus add. The live platform
  // took a PUT on one on 2026-09-25; this is the refusal the documentation
  // describes (its status is not documented, so a bare 400 stands for it).
  const platform = fakeMem0Platform();
  const entry = ours(platform, "Deploys go out on Tuesdays.", { origin: "human" });
  const { store, sent } = storeOn(platform, (request) => (request.method === "PUT" ? json({ error: "Immutable memories cannot be updated" }, 400) : undefined));
  const answer = await store.apply(applying({ update: [{ id: entry.id, text: "Deploys go out on Thursdays." }] }));
  const replacement = platform.memories.find((memory) => memory.memory === "Deploys go out on Thursdays.");
  assert.deepEqual(answer.ok && answer.outcomes, [{ op: "update", index: 0, result: "updated", previousId: entry.id, id: replacement?.id }]);
  assert.deepEqual(calls(sent).slice(1), [`PUT /v1/memories/${entry.id}/`, "POST /v3/memories/add/", `DELETE /v1/memories/${entry.id}/`]);
  assert.deepEqual(platform.memories.map((memory) => [memory.memory, memory.metadata?.origin]), [["Deploys go out on Thursdays.", "human"]]);
});

test("a replacement whose new text another entry already holds changes nothing and names that entry", async () => {
  // Mistake (seen live): Mem0 answers an exact repeat with the id holding it,
  // so deleting "the old entry" afterwards would fold two entries into one.
  const platform = fakeMem0Platform();
  const entry = ours(platform, "Deploys go out on Tuesdays.");
  const other = ours(platform, "Deploys go out on Thursdays.");
  const { store } = storeOn(platform, (request) => (request.method === "PUT" ? json({ error: "Immutable" }, 400) : undefined));
  const answer = await store.apply(applying({ update: [{ id: entry.id, text: "Deploys go out on Thursdays." }] }));
  const [outcome] = answer.ok ? answer.outcomes : [];
  assert.equal(outcome?.result === "failed" && [outcome.code, outcome.heldId].join(" "), `rejected ${other.id}`);
  assert.deepEqual(platform.memories.map((memory) => memory.memory), ["Deploys go out on Tuesdays.", "Deploys go out on Thursdays."]);
});

test("a replacement whose delete failed is a failed item, not an update, and both texts are left for core to find", async () => {
  const platform = fakeMem0Platform();
  const entry = ours(platform, "Deploys go out on Tuesdays.");
  const { store } = storeOn(platform, (request) => {
    if (request.method === "PUT") return json({ error: "Immutable" }, 400);
    if (request.method === "DELETE") return undocumented.unavailable();
    return undefined;
  });
  const answer = await store.apply(applying({ update: [{ id: entry.id, text: "Deploys go out on Thursdays." }] }));
  assert.equal(answer.ok, true);
  const [outcome] = answer.ok ? answer.outcomes : [];
  assert.equal(outcome?.result === "failed" && `${outcome.code} ${outcome.status}`, "unavailable 503");
  assert.match(outcome?.result === "failed" ? outcome.detail : "", /stored the new text as .* and did not delete the old entry/u);
  assert.equal(platform.memories.length, 2);
});

test("a replacement whose add Mem0 queued deletes the old entry and answers pending with the old id", async () => {
  const platform = fakeMem0Platform();
  const entry = ours(platform, "Deploys go out on Tuesdays.");
  const { store } = storeOn(platform, (request) => {
    if (request.method === "PUT") return json({ error: "Immutable" }, 400);
    if (request.url.pathname === "/v3/memories/add/") return recorded("live-add-queued.json");
    return undefined;
  });
  const answer = await store.apply(applying({ update: [{ id: entry.id, text: "Deploys go out on Thursdays." }] }));
  assert.deepEqual(answer.ok && answer.outcomes, [{ op: "update", index: 0, result: "pending", previousId: entry.id }]);
  assert.equal(platform.memories.length, 0);
});

// ---------------------------------------------------------------------------
// Removals and forget: delete_linked

test("an apply removes only what core named: no delete_linked, and a memory the removed one superseded stays", async () => {
  const platform = fakeMem0Platform();
  const older = ours(platform, "The API listens on port 3000.");
  const newer = ours(platform, "The API listens on port 3001.");
  older.replaced_by = newer.id;
  const { store, sent } = storeOn(platform);
  const answer = await store.apply(applying({ remove: [{ id: newer.id, reason: "refuted" }] }));
  assert.deepEqual(answer.ok && answer.outcomes, [{ op: "remove", index: 0, result: "removed", id: newer.id, reason: "refuted" }]);
  assert.deepEqual(calls(sent).slice(1), [`DELETE /v1/memories/${newer.id}/`]);
  const held = await store.held({ subject: REPO, kind: "facts" });
  assert.deepEqual(held.ok && held.entries.map((entry) => [entry.text, entry.replacedBy]), [["The API listens on port 3000.", undefined]]);
});

test("forget deletes with delete_linked, and names the superseded memories Mem0 took with it", async () => {
  // Q2: an erasure that left the older wording of a fact behind is not one.
  const platform = fakeMem0Platform();
  const older = ours(platform, "The API listens on port 3000.");
  const newer = ours(platform, "The API listens on port 3001.");
  const lesson = platform.seed({ memory: "Port 3000 was wrong.", user_id: REPO, agent_id: "lessons", app_id: MEM0_NAMESPACE, metadata: { origin: "learned" } });
  const kept = ours(platform, "Tests run with vitest.");
  older.replaced_by = newer.id;
  lesson.replaced_by = older.id;
  const { store, sent } = storeOn(platform);
  const answer = await store.forget({ subject: REPO, kind: "facts", textHash: await memoryTextHash("the api listens on port 3001") });
  assert.deepEqual(answer.ok && [...answer.removed].sort((a, b) => a.id.localeCompare(b.id)), [
    { id: older.id, kind: "facts" },
    { id: newer.id, kind: "facts" },
    { id: lesson.id, kind: "lessons" },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  assert.ok(calls(sent).includes(`DELETE /v1/memories/${newer.id}/?delete_linked=true`));
  assert.deepEqual(platform.memories.map((memory) => memory.id), [kept.id]);
});

test("forget reaches a memory Mem0 merged into another, which a default listing hides, by asking for merged ones too", async () => {
  // Mistake: Mem0 hides a merged original from a default listing (its Dream
  // page), so a forget by that original's text found nothing and the text
  // stayed in Mem0.
  const platform = fakeMem0Platform();
  const canonical = ours(platform, "The API listens on port 3000 over HTTPS.");
  const original = ours(platform, "The API listens on port 3000.");
  original.merged = true;
  const { store, sent } = storeOn(platform);
  const answer = await store.forget({ subject: REPO, textHash: await memoryTextHash("The API listens on port 3000.") });
  assert.deepEqual(answer, { ok: true, removed: [{ id: original.id, kind: "facts" }] });
  assert.deepEqual(platform.memories.map((memory) => memory.id), [canonical.id]);
  assert.deepEqual(listings(sent).map((request) => (request.body as Record<string, unknown>).include_merged), [true]);
});

test("after a cascade, forget names every memory of the subject that went, whatever link Mem0 followed, and no merged one that stayed", async () => {
  // Mistake: naming only the replaced_by chain, when Mem0's cascade follows
  // links no listing shows (its linked_memory_ids), so core records an
  // erasure that left a memory unnamed; or a listing after it without merged
  // ones, naming a merged memory that is still there as removed.
  const platform = fakeMem0Platform();
  const target = ours(platform, "The API listens on port 3001.");
  const linkedOnly = ours(platform, "The API listened on port 3000 before the move.");
  const lesson = platform.seed({ memory: "Port 3000 was wrong.", user_id: REPO, agent_id: "lessons", app_id: MEM0_NAMESPACE, metadata: { origin: "learned" } });
  const mergedKept = ours(platform, "Tests run with vitest.");
  target.linked = [linkedOnly.id];
  lesson.replaced_by = target.id;
  mergedKept.merged = true;
  const { store, sent, logs } = storeOn(platform);
  const answer = await store.forget({ subject: REPO, kind: "facts", textHash: await memoryTextHash("The API listens on port 3001.") });
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  assert.deepEqual(answer.ok && [...answer.removed].sort(byId), [
    { id: target.id, kind: "facts" },
    { id: linkedOnly.id, kind: "facts" },
    { id: lesson.id, kind: "lessons" },
  ].sort(byId));
  assert.deepEqual(platform.memories.map((memory) => memory.id), [mergedKept.id]);
  assert.deepEqual(listings(sent).map((request) => (request.body as Record<string, unknown>).include_merged), [true, true]);
  assert.deepEqual(logs, []);
});

test("a cascade that took memories forget cannot name (another application's) is logged with the counts", async () => {
  const platform = fakeMem0Platform();
  const target = ours(platform, "The API listens on port 3001.");
  const foreign = platform.seed({ memory: "Alice likes tea.", user_id: REPO, agent_id: "facts", app_id: "chatbot" });
  target.linked = [foreign.id];
  const { store, logs } = storeOn(platform);
  const answer = await store.forget({ subject: REPO });
  assert.deepEqual(answer, { ok: true, removed: [{ id: target.id, kind: "facts" }] });
  assert.deepEqual(logs.map((line) => [line.level, line.event, line.fields]), [["warn", "mem0_forget_cascade_beyond_subject", { cascaded: 1, named: 0 }]]);
});

test("a forget whose listing after the cascade failed answers unavailable, so core asks again, even when Mem0 refused that listing as a bad request", async () => {
  // Mistake: the deletes landed, so a rejected answer ("asking again will not
  // help") would leave core with an erasure it never finishes.
  const cases: readonly [string, () => Response, number][] = [
    ["a 503", () => undocumented.unavailable(), 503],
    ["a 400", () => json({ error: "Validation error", details: { message: "filters is invalid" } }, 400), 400],
  ];
  for (const [what, relist, status] of cases) {
    const platform = fakeMem0Platform();
    const older = ours(platform, "The API listens on port 3000.");
    const newer = ours(platform, "The API listens on port 3001.");
    older.replaced_by = newer.id;
    let listed = 0;
    const { store } = storeOn(platform, (request) => (request.url.pathname === "/v3/memories/" && (listed += 1) === 2 ? relist() : undefined));
    const answer = await store.forget({ subject: REPO, textHash: await memoryTextHash("The API listens on port 3001.") });
    assert.equal(answer.ok === false && `${answer.code} ${answer.status}`, `unavailable ${status}`, what);
    assert.match(answer.ok ? "" : answer.detail, /deleted what forget asked and 1 linked memories with it, then listing what is left failed/u, what);
    assert.deepEqual(platform.memories, [], what);
  }
});

test("Mem0's live answer to a delete with delete_linked is read as a delete that took nothing else", async () => {
  const platform = fakeMem0Platform();
  const entry = ours(platform, "The API listens on port 3000.");
  const { store, sent } = storeOn(platform, (request) => (request.method === "DELETE" ? recorded("live-delete-linked.json") : undefined));
  const answer = await store.forget({ subject: REPO });
  assert.deepEqual(answer, { ok: true, removed: [{ id: entry.id, kind: "facts" }] });
  // No second listing: nothing cascaded.
  assert.deepEqual(calls(sent), ["POST /v3/memories/?page=1&page_size=200", `DELETE /v1/memories/${entry.id}/?delete_linked=true`]);
});

test("forget of a memory another writer deleted first (404, live body) removes nothing and is not a failure", async () => {
  const platform = fakeMem0Platform();
  ours(platform, "The API listens on port 3000.");
  const { store } = storeOn(platform, (request) => (request.method === "DELETE" ? recorded("live-memory-not-found.json", 404) : undefined));
  assert.deepEqual(await store.forget({ subject: REPO }), { ok: true, removed: [] });
});

// ---------------------------------------------------------------------------
// Identity

test("the identity a run pins is the organization and project the key resolves to", async () => {
  const { ctx } = mem0Answering(() => json({ status: "ok", org_id: "org-example-1", project_id: "proj-example-1", user_email: "someone@example.com" }));
  assert.deepEqual(await readMem0Identity(ctx), { ok: true, identity: { orgId: "org-example-1", projectId: "proj-example-1" } });
});

test("a ping that names no project answers no identity rather than a made-up one", async () => {
  const { ctx } = mem0Answering(() => recorded("ping-status-only.json"));
  assert.deepEqual(await readMem0Identity(ctx), { ok: true, identity: null });
});

test("a ping Mem0 refuses answers key_rejected with the status", async () => {
  const { ctx, sent } = mem0Answering(() => recorded("live-unauthorized.json", 401));
  const answer = await readMem0Identity(ctx);
  assert.equal(answer.ok === false && `${answer.code} ${answer.reason} ${answer.status}`, "unavailable key_rejected 401");
  assert.equal(sent[0]?.retries, 0);
});
