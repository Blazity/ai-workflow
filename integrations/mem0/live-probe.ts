/**
 * The live probe of Mem0's hosted platform: how it really answers the calls the
 * memory store (`store.ts`) makes, recorded so the fake in the tests models
 * Mem0 as it behaves rather than as its pages describe it.
 *
 * It reads the API key from stdin, so the key is never in an argument, the
 * environment, a file or a log:
 *
 *   security find-generic-password -a "$USER" -s aiw-mem0 -w \
 *     | pnpm --silent run probe:live <record.json> [raw|store|all]
 *
 * `raw` records Mem0's own answers to each call the store relies on, `store`
 * runs the store itself through every member, `all` does both.
 *
 * Safety, because the only key there may be a production project's:
 * - everything it writes carries `app_id` `ai-workflow-probe` and a `user_id`
 *   that starts with `aiw-probe-`; it reads, updates and deletes nothing else;
 * - one call at a time with a pause between, and it stops at the first 429;
 * - it deletes everything it created, whatever happened before, and records a
 *   listing of the probe ids that has to come back empty;
 * - the record holds no key: every value is checked for it and replaced, and
 *   no request header is recorded.
 *
 * Not part of the integration: nothing imports it, it is not a test, and it
 * never runs in CI (it needs a real key). It does its work only when run as
 * the entry point: importing it reads no argument and no stdin and sends
 * nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { memoryTextHash, type IntegrationContext, type MemoryStore } from "@integrations/sdk";
import type { manifest } from "./manifest";

const API = "https://api.mem0.ai";
const APP = "ai-workflow-probe";
const PREFIX = "aiw-probe-";
const RUN = `${PREFIX}${Date.now().toString(36)}`;
const PAUSE_MS = 400;
const ATTEMPT_MS = 30_000;

/** The API key, read from stdin by `main` and nowhere else. */
let key = "";

interface Recorded {
  readonly step: string;
  readonly method: string;
  readonly path: string;
  readonly sent?: unknown;
  readonly status: number | "threw";
  readonly ms: number;
  readonly body: unknown;
}

const record: { run: string; startedAt: string; calls: Recorded[]; notes: Record<string, unknown>; stoppedBy?: string } = {
  run: RUN,
  startedAt: new Date().toISOString(),
  calls: [],
  notes: {},
};

/** Every id the probe saw under a probe user, so cleanup reaches merged or hidden ones too. */
const seenIds = new Set<string>();

class RateLimited extends Error {}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function redact(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  return JSON.parse(key.length === 0 ? text : text.split(key).join("[REDACTED]"));
}

function user(name: string): string {
  return `${RUN}-${name}`;
}

async function call(
  step: string,
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string>; apiKey?: string; allow429?: boolean } = {},
): Promise<{ status: number; body: any; ms: number }> {
  await sleep(PAUSE_MS);
  const url = new URL(path, API);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Token ${options.apiKey ?? key}`,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(ATTEMPT_MS),
    });
  } catch (error) {
    const ms = Date.now() - started;
    record.calls.push({ step, method, path: url.pathname + url.search, sent: redact(options.body), status: "threw", ms, body: String(error) });
    throw error;
  }
  const ms = Date.now() - started;
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  record.calls.push({ step, method, path: url.pathname + url.search, sent: redact(options.body), status: response.status, ms, body: redact(body) });
  collectIds(body);
  if (response.status === 429 && !options.allow429) throw new RateLimited(`429 at ${step}`);
  return { status: response.status, body, ms };
}

function collectIds(body: unknown): void {
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string" && (typeof object.memory === "string" || typeof object.data === "object")) {
      const owner = object.user_id;
      if (owner === undefined || owner === null || (typeof owner === "string" && owner.startsWith(PREFIX))) seenIds.add(object.id);
    }
    Object.values(object).forEach(visit);
  };
  visit(body);
}

const probeFilters = (users: readonly string[], agents?: readonly string[]) => ({
  AND: [{ app_id: APP }, { user_id: { in: users } }, ...(agents ? [{ agent_id: { in: agents } }] : [])],
});

async function listOf(step: string, users: readonly string[], extra: Record<string, unknown> = {}) {
  return call(step, "POST", "/v3/memories/", { body: { filters: probeFilters(users), ...extra }, query: { page: "1", page_size: "200" } });
}

async function add(step: string, userId: string, texts: readonly string[], options: { immutable?: boolean; infer?: boolean; agent?: string; metadata?: Record<string, unknown> } = {}) {
  return call(step, "POST", "/v3/memories/add/", {
    body: {
      messages: texts.map((content) => ({ role: "user", content })),
      user_id: userId,
      agent_id: options.agent ?? "facts",
      app_id: APP,
      metadata: options.metadata ?? { origin: "learned", runId: `${RUN}-run` },
      infer: options.infer ?? false,
      ...(options.immutable === undefined ? {} : { immutable: options.immutable }),
    },
  });
}

async function search(step: string, users: readonly string[], query: string, extra: Record<string, unknown> = {}) {
  return call(step, "POST", "/v3/memories/search/", {
    body: { query, filters: probeFilters(users, ["facts", "lessons"]), threshold: 0, top_k: 1000, ...extra },
  });
}

function idsOfAdd(body: any): string[] {
  return Array.isArray(body?.results) ? body.results.map((result: any) => result.id) : [];
}

/** Polls a search until `text` is in it, answering how long that took, or null after `limitMs`. */
async function timeUntilSearchable(step: string, users: readonly string[], query: string, text: string, limitMs = 15_000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const found = await search(step, users, query);
    if ((found.body?.results ?? []).some((result: any) => result.memory === text)) return Date.now() - started;
    await sleep(1_500);
  }
  return null;
}

async function waitForEvent(step: string, eventId: string, limitMs = 60_000): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const event = await call(step, "GET", `/v1/event/${eventId}/`);
    if (event.body?.status === "SUCCEEDED" || event.body?.status === "FAILED") return { ...event.body, waitedMs: Date.now() - started };
    await sleep(1_500);
  }
  return null;
}

async function raw(): Promise<void> {
  const notes = record.notes;

  // Identity and a refused key.
  const ping = await call("ping", "GET", "/v1/ping/");
  notes.ping = { status: ping.status, keys: Object.keys(ping.body ?? {}) };
  const badKey = "m0-aiwprobeinvalidkey0000000000000000";
  notes.pingBadKey = (await call("ping-bad-key", "GET", "/v1/ping/", { apiKey: badKey })).status;
  notes.listBadKey = (await call("list-bad-key", "POST", "/v3/memories/", { apiKey: badKey, body: { filters: probeFilters([user("a")]) } })).status;

  // Add: shape, synchronous or queued, time until listed and searchable.
  const a = user("a");
  const portText = "Probe fact: the API listens on port 3000.";
  const added = await add("add-mutable", a, [portText], { immutable: false, metadata: { origin: "learned", runId: "r1", ticketKey: "T-1" } });
  const [portId] = idsOfAdd(added.body);
  const listed = await listOf("add-mutable-listed", [a]);
  notes.addMutable = { ms: added.ms, status: added.body?.status, listedRightAway: (listed.body?.results ?? []).some((m: any) => m.id === portId) };
  notes.addMutableSearchableAfterMs = await timeUntilSearchable("add-mutable-searchable", [a], "Which port does the API listen on?", portText);

  const b = user("b");
  const tuesday = "Probe fact: deploys go out on Tuesdays.";
  const addedImmutable = await add("add-immutable", b, [tuesday], { immutable: true });
  const [tuesdayId] = idsOfAdd(addedImmutable.body);
  notes.addImmutableSearchableAfterMs = await timeUntilSearchable("add-immutable-searchable", [b], "When do deploys go out?", tuesday);
  if (tuesdayId) await call("get-immutable", "GET", `/v1/memories/${tuesdayId}/`);

  // An exact repeat, and a multi-message add holding one.
  notes.exactRepeat = idsOfAdd((await add("add-exact-repeat", a, [portText], { immutable: false })).body);
  const multi = await add("add-multi-with-repeat", a, ["Probe fact: the API uses Postgres 16.", portText, "Probe fact: releases are tagged by a bot."], { immutable: false });
  notes.multiResults = (multi.body?.results ?? []).map((r: any) => r.data?.memory);

  // Search: completeness at threshold 0 across two subjects and two kinds.
  const c = user("c");
  const cFacts = [
    "Probe fact: the web app is built with Next.js.",
    "Probe fact: CI runs on GitHub Actions.",
    "Probe fact: the worker runs on Vercel functions.",
    "Probe fact: feature flags live in the settings table.",
    "Probe fact: the database is Neon Postgres.",
    "Probe fact: tests run with vitest.",
  ];
  await add("seed-c-facts", c, cFacts, { immutable: false });
  await add("seed-c-lessons", c, ["Probe lesson: run migrations before the seed script.", "Probe lesson: wait for the session cookie, not a timer."], { immutable: false, agent: "lessons" });
  const heldForSearch = await call("list-a-c", "POST", "/v3/memories/", { body: { filters: probeFilters([a, c], ["facts", "lessons"]) }, query: { page: "1", page_size: "200" } });
  const related = await search("search-related", [a, c], "Which port does the API listen on and what database does it use?");
  const unrelated = await search("search-unrelated", [a, c], "zebra quasar nebula");
  const defaultThreshold = await call("search-default-threshold", "POST", "/v3/memories/search/", {
    body: { query: "zebra quasar nebula", filters: probeFilters([a, c], ["facts", "lessons"]) },
  });
  notes.searchCompleteness = {
    held: heldForSearch.body?.count,
    related: related.body?.results?.length,
    unrelated: unrelated.body?.results?.length,
    unrelatedDefaultThreshold: defaultThreshold.body?.results?.length,
    relatedScores: (related.body?.results ?? []).map((r: any) => r.score),
  };

  // Near-duplicate and conflicting pairs, with and without immutable.
  const pairs = ["Probe fact: tests run with vitest.", "Probe fact: tests run with vitest run.", "Probe fact: the API listens on port 3000.", "Probe fact: the API listens on port 3001.", "Probe fact: tests do not run with vitest."];
  for (const [label, immutable] of [["d", false], ["e", true]] as const) {
    const who = user(label);
    for (const [index, text] of pairs.entries()) await add(`pair-${label}-${index}`, who, [text], { immutable });
    await sleep(3_000);
    const plain = await listOf(`pair-${label}-list`, [who]);
    const merged = await listOf(`pair-${label}-list-include-merged`, [who], { include_merged: true });
    await search(`pair-${label}-search`, [who], "What do the tests run with and which port does the API listen on?");
    for (const memory of plain.body?.results ?? []) await call(`pair-${label}-history`, "GET", `/v1/memories/${memory.id}/history/`);
    notes[`pairs-${label}`] = {
      immutable,
      listed: plain.body?.results?.length,
      listedIncludeMerged: merged.status === 200 ? merged.body?.results?.length : `status ${merged.status}`,
      replacedBy: (plain.body?.results ?? []).filter((m: any) => m.replaced_by).map((m: any) => [m.memory, m.replaced_by]),
    };
  }

  // A conflicting pair through Mem0's own add (infer true): what Supersede and a queued add look like.
  const f = user("f");
  const first = await add("infer-first", f, ["My API service listens on port 3000."], { infer: true });
  notes.inferQueued = { status: first.body?.status, eventId: typeof first.body?.event_id === "string" };
  if (first.body?.event_id) notes.inferFirstEvent = await waitForEvent("infer-first-event", first.body.event_id);
  const second = await add("infer-second", f, ["We moved the API service: it now listens on port 4000, not 3000."], { infer: true });
  if (second.body?.event_id) notes.inferSecondEvent = await waitForEvent("infer-second-event", second.body.event_id);
  await sleep(3_000);
  const inferred = await listOf("infer-list", [f]);
  notes.inferReplacedBy = (inferred.body?.results ?? []).map((m: any) => [m.memory, m.agent_id, m.replaced_by ?? null]);
  for (const memory of inferred.body?.results ?? []) await call("infer-history", "GET", `/v1/memories/${memory.id}/history/`);

  // Update in place, and what metadata does on a PUT.
  if (portId) {
    const put = await call("put-mutable", "PUT", `/v1/memories/${portId}/`, { body: { text: "Probe fact: the API listens on port 8080.", metadata: { origin: "learned", runId: "r2" } } });
    const after = await call("put-mutable-get", "GET", `/v1/memories/${portId}/`);
    notes.putMutable = { status: put.status, sameId: put.body?.id === portId, metadataAfter: after.body?.metadata, text: after.body?.memory };
    await call("put-mutable-history", "GET", `/v1/memories/${portId}/history/`);
    notes.readdOldTextAfterPut = idsOfAdd((await add("readd-old-text-after-put", a, [portText], { immutable: false })).body);
    notes.putSearchableAfterMs = await timeUntilSearchable("put-searchable", [a], "Which port does the API listen on?", "Probe fact: the API listens on port 8080.");
  }
  // Update of an immutable entry: refused, then delete plus add.
  if (tuesdayId) {
    const put = await call("put-immutable", "PUT", `/v1/memories/${tuesdayId}/`, { body: { text: "Probe fact: deploys go out on Thursdays." } });
    notes.putImmutable = { status: put.status, body: redact(put.body) };
    const replacement = await add("replace-immutable-add", b, ["Probe fact: deploys go out on Thursdays."], { immutable: true });
    const removed = await call("replace-immutable-delete", "DELETE", `/v1/memories/${tuesdayId}/`);
    notes.replaceImmutable = { added: idsOfAdd(replacement.body), deleteStatus: removed.status, deleteBody: removed.body };
    const historyOfDeleted = await call("history-of-deleted", "GET", `/v1/memories/${tuesdayId}/history/`);
    notes.historyOfDeleted = { status: historyOfDeleted.status, entries: Array.isArray(historyOfDeleted.body) ? historyOfDeleted.body.length : null };
    notes.deleteAgain = (await call("delete-again", "DELETE", `/v1/memories/${tuesdayId}/`)).status;
  }

  // Forget with delete_linked, on a memory that superseded another when there is one.
  const superseding = [...(inferred.body?.results ?? []), ...((await listOf("linked-find", [user("d"), user("e")])).body?.results ?? [])].find((m: any) => m.replaced_by);
  const target = superseding ? superseding.replaced_by : (await listOf("linked-plain", [c])).body?.results?.[0]?.id;
  if (target) {
    const linked = await call("delete-linked", "DELETE", `/v1/memories/${target}/`, { query: { delete_linked: "true" } });
    notes.deleteLinked = { onSuperseding: Boolean(superseding), status: linked.status, body: linked.body };
    if (superseding) notes.supersededAfterLinkedDelete = (await call("delete-linked-check", "GET", `/v1/memories/${superseding.id}/`)).status;
  }

  // Does a queued add that lands after a forget of the same text bring it back?
  const g = user("g");
  const echo = "The staging database is reset every Sunday night.";
  const synchronous = await add("race-sync-copy", g, [echo], { immutable: false });
  const queued = await add("race-queued-add", g, [echo], { infer: true });
  const beforeForget = await listOf("race-list-before-forget", [g]);
  for (const memory of beforeForget.body?.results ?? []) await call("race-forget", "DELETE", `/v1/memories/${memory.id}/`);
  notes.raceHeldAtForget = (beforeForget.body?.results ?? []).map((m: any) => m.memory);
  if (queued.body?.event_id) notes.raceEvent = await waitForEvent("race-event", queued.body.event_id);
  await sleep(2_000);
  notes.raceAfter = ((await listOf("race-list-after", [g])).body?.results ?? []).map((m: any) => m.memory);
  notes.raceSyncAdded = idsOfAdd(synchronous.body).length;

  // Sizes: one long memory and one long query.
  const h = user("h");
  const long = `Probe long fact: ${"abcdefghij ".repeat(360)}`.trim();
  const longer = `Probe longer fact: ${"abcdefghij ".repeat(3_600)}`.trim();
  for (const [label, text] of [["4k", long], ["40k", longer]] as const) {
    const answer = await add(`size-${label}`, h, [text], { immutable: false });
    const stored = answer.body?.results?.[0]?.data?.memory;
    notes[`size-${label}`] = { sent: text.length, status: answer.status, stored: typeof stored === "string" ? stored.length : null };
  }
  const longQuery = await search("long-query", [h], `Probe ${"long query words ".repeat(180)}`);
  notes.longQuery = { chars: 6 + 17 * 180, status: longQuery.status };
}

/** The adapter itself against live Mem0, under the probe namespace: one small pass through every member. */
async function store(): Promise<void> {
  const notes: Record<string, unknown> = {};
  record.notes.store = notes;
  // Imported here, so the raw pass runs whatever state the store is in.
  const { mem0MemoryStore, readMem0Identity } = await import("./store");
  const ctx = liveContext();
  const memory: MemoryStore = mem0MemoryStore(ctx, { namespace: APP });
  const subject = user("store");
  const other = user("store-web");
  notes.identity = await readMem0Identity(ctx).then((answer) => (answer.ok ? { ok: true, named: answer.identity !== null } : answer));

  const first = await memory.apply({
    subject,
    kind: "facts",
    runId: "store-run-1",
    ticketKey: "PROBE-1",
    add: [
      { text: "The API listens on port 3000.", origin: "learned" },
      { text: "Deploys go out on Tuesdays.", origin: "derived", protect: true },
      { text: "Tests run with vitest.", origin: "learned" },
    ],
    update: [],
    remove: [],
  });
  notes.applyAdd = first;
  await memory.apply({ subject: other, kind: "facts", add: [{ text: "The web app is built with Next.js.", origin: "human" }], update: [], remove: [] });
  const held = await memory.held({ subject, kind: "facts" });
  notes.held = held;
  const recalled = await memory.recall({ subjects: [subject, other], kinds: ["facts", "lessons"], query: "Which port does the API listen on?" });
  notes.recallRanked = recalled;
  notes.recallUnranked = await memory.recall({ subjects: [subject, other], kinds: ["facts"] });
  if (held.ok) {
    const port = held.entries.find((entry) => entry.text.includes("3000"));
    const tuesday = held.entries.find((entry) => entry.text.includes("Tuesdays"));
    notes.applyUpdate = await memory.apply({
      subject,
      kind: "facts",
      runId: "store-run-2",
      add: [],
      update: [
        ...(port ? [{ id: port.id, text: "The API listens on port 8080." }] : []),
        ...(tuesday ? [{ id: tuesday.id, text: "Deploys go out on Thursdays.", protect: true as const }] : []),
      ],
      remove: [{ id: "00000000-0000-4000-8000-000000000000", reason: "refuted" }],
    });
    notes.heldAfterUpdate = await memory.held({ subject, kind: "facts" });
  }
  notes.list = await memory.list();
  const hash = await memoryTextHash("tests run with vitest");
  notes.forgetByText = await memory.forget({ subject, kind: "facts", textHash: hash });
  notes.forgetSubject = await memory.forget({ subject });
  notes.forgetOther = await memory.forget({ subject: other });
  notes.listAfterForget = await memory.list();
  record.notes.store = redact(notes) as Record<string, unknown>;
}

function liveContext(): IntegrationContext<typeof manifest> {
  const line = () => () => {};
  return {
    connection: { apiKey: key },
    http: {
      fetch: async (input, init = {}) => {
        await sleep(PAUSE_MS);
        const { timeoutMs, retries: _retries, ...rest } = init;
        const started = Date.now();
        const response = await fetch(input, { ...rest, signal: AbortSignal.timeout(timeoutMs ?? ATTEMPT_MS) });
        const text = await response.text();
        const url = new URL(input instanceof Request ? input.url : input);
        let body: unknown = text;
        try {
          body = text === "" ? null : JSON.parse(text);
        } catch {
          body = text.slice(0, 500);
        }
        record.calls.push({
          step: "store",
          method: rest.method ?? "GET",
          path: url.pathname + url.search,
          sent: redact(typeof rest.body === "string" ? JSON.parse(rest.body) : undefined),
          status: response.status,
          ms: Date.now() - started,
          body: redact(body),
        });
        collectIds(body);
        if (response.status === 429) throw new RateLimited("429 in the store pass");
        return new Response(text, { status: response.status, headers: response.headers });
      },
    },
    log: { debug: line(), info: line(), warn: line(), error: line() },
    signal: new AbortController().signal,
  };
}

/** Deletes every memory under a probe user id in the probe app, then lists them again: that listing must be empty. */
async function cleanup(): Promise<void> {
  const everything = await call("cleanup-list", "POST", "/v3/memories/", {
    body: { filters: { AND: [{ app_id: APP }, { user_id: "*" }] } },
    query: { page: "1", page_size: "200" },
    allow429: true,
  });
  const owned = (everything.body?.results ?? []).filter((m: any) => typeof m.user_id === "string" && m.user_id.startsWith(PREFIX) && m.app_id === APP);
  for (const memory of owned) seenIds.add(memory.id);
  for (const id of seenIds) {
    await call("cleanup-delete", "DELETE", `/v1/memories/${id}/`, { allow429: true });
  }
  const after = await call("cleanup-verify", "POST", "/v3/memories/", {
    body: { filters: { AND: [{ app_id: APP }, { user_id: "*" }] } },
    query: { page: "1", page_size: "200" },
    allow429: true,
  });
  const byUser = await call("cleanup-verify-by-run", "POST", "/v3/memories/", {
    body: { filters: { AND: [{ user_id: { in: ["a", "b", "c", "d", "e", "f", "g", "h", "store", "store-web"].map(user) } }] } },
    query: { page: "1", page_size: "200" },
    allow429: true,
  });
  record.notes.cleanup = { deleted: seenIds.size, remainingInProbeApp: after.body?.count, remainingUnderProbeUsers: byUser.body?.count };
}

async function main(): Promise<void> {
  const [recordPath, phase = "all"] = process.argv.slice(2);
  if (!recordPath) throw new Error("Usage: node --import tsx live-probe.ts <record.json> [raw|store|all] (the key on stdin)");
  key = readFileSync(0, "utf8").trim();
  if (key.length < 8) throw new Error("No API key on stdin.");
  try {
    if (phase === "raw" || phase === "all") await raw();
    if (phase === "store" || phase === "all") await store();
  } catch (error) {
    record.stoppedBy = error instanceof RateLimited ? `rate limited: ${error.message}` : String(redact(String(error)));
    if (error instanceof RateLimited) await sleep(60_000);
  } finally {
    await cleanup();
    writeFileSync(recordPath, `${JSON.stringify(redact(record), null, 2)}\n`);
    console.log(JSON.stringify({ run: RUN, calls: record.calls.length, stoppedBy: record.stoppedBy ?? null, cleanup: record.notes.cleanup }));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
