/**
 * Mem0 as a memory store: version 2 of the memory port (`MemoryStore`), beside
 * version 1 (`memory.ts`) until core moves onto it. Nothing calls it yet; the
 * stage that wires version 2 adds the factory slot.
 *
 * HOW CORE'S ADDRESSES MAP ONTO MEM0 (version 1's mapping, so both read the
 * same memories):
 *
 * | Core                        | Mem0                                    |
 * |-----------------------------|-----------------------------------------|
 * | this integration            | `app_id` = `MEM0_NAMESPACE`             |
 * | subject                     | `user_id`, exactly                      |
 * | kind (`facts`, `lessons`)   | `agent_id`                              |
 * | origin, runId, ticketKey    | `metadata.origin`, `.runId`, `.ticketKey` |
 * | the order entries came in   | `metadata.addedAt`, this store's clock  |
 *
 * WHAT MEM0 DOES, AS SEEN LIVE ON 2026-09-25 (`live-probe.ts`, the README):
 *
 * - An add with `infer: false` is stored verbatim and synchronously (a 40,000
 *   character text came back whole), listed at once and searchable within a
 *   second. An exact repeat of a text the scope holds answers that memory's
 *   id instead of storing a second copy. The OpenAPI still documents a queued
 *   answer (`PENDING`, an event id, no memory id); this store answers
 *   `pending` for it and never an id Mem0 did not give.
 * - A listing gives `created_at` to the second and, within a second, in no
 *   documented order, so `held` orders by `metadata.addedAt`, which every add
 *   writes, and by `created_at` for a memory written before it.
 * - `PUT` keeps the id and Mem0's history and replaces the whole metadata. It
 *   was not refused on a memory added with `immutable: true`, although the
 *   documentation says it is; so an update is a PUT, and only a PUT Mem0
 *   refuses as a bad request becomes a replacement (add first, delete second).
 * - Supersede and Merge never touched a direct import, alike or
 *   contradictory, protected or not. Mem0 documents both as running on every
 *   add, so the store declares that it consolidates (core then compares what
 *   `held` returns with its own record) and that `protect` proves nothing
 *   (`protects: false`): it writes no `immutable`, since that changed nothing
 *   observable and the documentation says it blocks updates in place.
 *
 * Every read, write and delete carries the namespace, and every answer is
 * checked against the subject and kind asked, so another application's
 * memories in the same Mem0 project never reach a prompt or an erasure.
 */
import {
  memoryTextHash,
  type IntegrationContext,
  type MemoryEntryOrigin,
  type MemoryHolding,
  type MemoryKind,
  type MemoryRecalledEntry,
  type MemoryStore,
  type MemoryStoreAnswer,
  type MemoryStoreApplyOutcome,
  type MemoryStoreApplyRequest,
  type MemoryStoreEntry,
  type MemoryStoreItemFailure,
  type MemoryStoreRefusal,
  type MemoryStoreUpdate,
} from "@integrations/sdk";
import type { manifest } from "./manifest";
import { MEM0_NAMESPACE } from "./memory";
import {
  MEM0_SEARCH_TOP_K_MAX,
  MEM0_STORE_PAGE_SIZE,
  Mem0StoreFailure,
  mem0StoreClient,
  type Mem0AddAnswer,
  type Mem0Filters,
  type Mem0Memory,
  type Mem0StoreClient,
} from "./store-client";

type Context = IntegrationContext<typeof manifest>;

const KINDS: readonly MemoryKind[] = ["facts", "lessons"];
const ORIGINS: ReadonlySet<string> = new Set<MemoryEntryOrigin>(["learned", "derived", "imported", "human"]);

/**
 * How many pages (of 200) one read goes through before it refuses: 2,000
 * memories under one subject and kind, far past what core keeps (40 facts),
 * and a bound on the time one read takes. The port wants the complete set,
 * so past it a read is refused rather than answered in part.
 */
const MAX_PAGES = 10;

/** How many texts one add sends; core's distill adds about a dozen. */
const ADD_BATCH = 50;

let lastAdded = 0;

/**
 * The time an add writes into `addedAt`: now, and later than every one this
 * process wrote before, so two applies within one millisecond keep their order
 * in `held` (Mem0's own `created_at` is listed to the second).
 */
function addedAtNow(): string {
  lastAdded = Math.max(Date.now(), lastAdded + 1);
  return new Date(lastAdded).toISOString();
}

export interface Mem0MemoryStoreOptions {
  /**
   * For the live probe only (`live-probe.ts`), which keeps its data apart: the
   * `app_id` to write and require. The integration always uses `MEM0_NAMESPACE`.
   */
  readonly namespace?: string;
}

/**
 * ONE STORE SERVES ONE STEP. Once Mem0 timed out or could not be reached, its
 * client sends nothing more (`mem0StoreClient`), so a store kept past its step
 * would leave Mem0 off for the rest of the process. Core builds one per step.
 */
export function mem0MemoryStore(ctx: Context, options: Mem0MemoryStoreOptions = {}): MemoryStore {
  const mem0 = mem0StoreClient(ctx);
  const namespace = options.namespace ?? MEM0_NAMESPACE;
  const reader = new Reader(mem0, namespace);
  return {
    traits: { consolidates: true, protects: false },
    recall: (request) =>
      answering(async () => {
        const subjects = [...new Set(request.subjects)];
        const kinds = [...new Set(request.kinds)];
        subjects.forEach(checkedSubject);
        kinds.forEach(checkedKind);
        if (subjects.length === 0 || kinds.length === 0) return { ok: true, ranked: false, entries: [] };
        const filters = reader.filters(subjects, kinds);
        const { memories } = await reader.readAll(filters);
        const stored = subjects.flatMap((subject) => kinds.flatMap((kind) => entriesOf(memories, namespace, subject, kind)));
        const query = request.query?.trim() ?? "";
        if (query.length === 0 || stored.length === 0) return { ok: true, ranked: false, entries: stored };
        let scores: ReadonlyMap<string, number>;
        try {
          scores = await mem0.search(query, filters, Math.min(MEM0_SEARCH_TOP_K_MAX, stored.length));
        } catch (error) {
          // The set is complete without the search, so recall answers it in
          // stored order, which is honest, rather than refusing it all.
          const failure = asFailure(error);
          ctx.log.warn({ code: failure.code, reason: failure.reason, status: failure.status }, "mem0_recall_search_unavailable");
          return { ok: true, ranked: false, entries: stored };
        }
        // Relevance orders and never filters: an entry the search did not
        // score keeps its place after every scored one.
        const scored: (MemoryRecalledEntry & { score: number })[] = [];
        const unscored: MemoryRecalledEntry[] = [];
        for (const entry of stored) {
          const score = scores.get(entry.id);
          if (score === undefined) unscored.push(entry);
          else scored.push({ ...entry, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return { ok: true, ranked: true, entries: [...scored, ...unscored] };
      }),

    held: (request) =>
      answering(async () => {
        checkedSubject(request.subject);
        checkedKind(request.kind);
        const { memories } = await reader.readAll(reader.filters([request.subject], [request.kind]));
        // Mem0 keeps no version of a subject, so there is none to compare and swap.
        return { ok: true, entries: entriesOf(memories, namespace, request.subject, request.kind) };
      }),

    apply: (request) => answering(() => apply(ctx, mem0, reader, namespace, request)),

    forget: (request) =>
      answering(async () => {
        checkedSubject(request.subject);
        if (request.kind !== undefined) checkedKind(request.kind);
        const kinds = request.kind === undefined ? KINDS : [request.kind];
        // Both kinds are read, because a delete takes the memories linked to
        // it with it, and those may be of either kind; and merged ones, which
        // Mem0 hides from a default listing and which still hold their text.
        const filters = reader.filters([request.subject], KINDS);
        const own = ownMemories((await reader.readAll(filters, { includeMerged: true })).memories, namespace, request.subject);
        const targets: Mem0Memory[] = [];
        for (const memory of own) {
          if (!kinds.includes(memory.agent_id as MemoryKind)) continue;
          if (request.textHash === undefined || (await memoryTextHash(memory.memory)) === request.textHash) targets.push(memory);
        }
        const removed: { id: string; kind: MemoryKind }[] = [];
        let cascaded = 0;
        for (const target of targets) {
          // An erasure that left the older wording of the same fact behind
          // would not be one, so its superseded memories go too.
          const answer = await mem0.remove(target.id, { linked: true });
          if (answer === "missing") continue;
          removed.push({ id: target.id, kind: target.agent_id as MemoryKind });
          cascaded += answer.cascaded;
        }
        if (cascaded > 0) {
          // Mem0 counts what the cascade took and names none of it, and which
          // links it follows was never seen live, so every memory of this
          // subject the listing no longer holds is named, not only the chain
          // `replaced_by` shows. (One another writer deleted meanwhile is
          // named too: it is gone all the same.)
          let left: ReadonlySet<string>;
          try {
            left = new Set((await reader.readAll(filters, { includeMerged: true })).memories.map((memory) => memory.id));
          } catch (error) {
            // The deletes landed, so this is never "asking again will not
            // help": core asks again, and the next forget finds what is left.
            const failure = asFailure(error);
            throw new Mem0StoreFailure(
              "unavailable",
              `Mem0 deleted what forget asked and ${cascaded} linked memories with it, then listing what is left failed, so which went is not known: ${failure.detail}`,
              "unknown",
              failure.reason,
              failure.status,
            );
          }
          const deleted = new Set(removed.map((entry) => entry.id));
          let named = 0;
          for (const memory of own) {
            if (deleted.has(memory.id) || left.has(memory.id)) continue;
            removed.push({ id: memory.id, kind: memory.agent_id as MemoryKind });
            named += 1;
          }
          // The rest belonged to another subject or application, or was never
          // listed: forget cannot name it, and a person should know it went.
          if (named < cascaded) ctx.log.warn({ cascaded, named }, "mem0_forget_cascade_beyond_subject");
        }
        return { ok: true, removed };
      }),

    list: () =>
      answering(async () => {
        const { memories, complete } = await reader.readAll({ AND: [{ app_id: namespace }, { agent_id: { in: KINDS } }] }, { beyond: "partial" });
        const holdings = new Map<string, { subject: string; kind: MemoryKind; entries: number; newest: number }>();
        let unaddressable = 0;
        for (const memory of memories) {
          if (!isOwn(memory, namespace)) {
            // Under this namespace without a subject: not written by this
            // store and not reachable through it, but there all the same.
            unaddressable += 1;
            continue;
          }
          const subject = memory.user_id as string;
          const kind = memory.agent_id as MemoryKind;
          const key = JSON.stringify([subject, kind]);
          const holding = holdings.get(key) ?? { subject, kind, entries: 0, newest: Number.NEGATIVE_INFINITY };
          holding.entries += 1;
          holding.newest = Math.max(holding.newest, timeOf(memory.updated_at ?? memory.created_at));
          holdings.set(key, holding);
        }
        const listed: MemoryHolding[] = [];
        for (const { subject, kind, entries, newest } of holdings.values()) {
          listed.push(Number.isFinite(newest) ? { subject, kind, entries, updatedAt: new Date(newest).toISOString() } : { subject, kind, entries });
        }
        return { ok: true, holdings: listed, complete: complete && unaddressable === 0 };
      }),
  };
}

/** Which Mem0 organization and project the key writes into (the identity a run pins), or null when Mem0 does not say. */
export interface Mem0Identity {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * `GET /v1/ping/`, the call Mem0's own SDKs make to resolve a key's
 * organization and project. A run pins what it answers, so a key swapped to
 * another project between two steps of one run is noticed.
 */
export function readMem0Identity(ctx: Context): Promise<MemoryStoreAnswer<{ identity: Mem0Identity | null }>> {
  return answering(async () => {
    const ping = await mem0StoreClient(ctx).ping();
    const identity = ping.org_id && ping.project_id ? { orgId: ping.org_id, projectId: ping.project_id } : null;
    return { ok: true, identity };
  });
}

// ---------------------------------------------------------------------------
// Answers

/** Every member answers and none throws: whatever escapes the body becomes a refusal. */
async function answering<T>(body: () => Promise<{ readonly ok: true } & T>): Promise<MemoryStoreAnswer<T>> {
  try {
    return await body();
  } catch (error) {
    return refusalOf(asFailure(error));
  }
}

function refusalOf(failure: Mem0StoreFailure): MemoryStoreRefusal {
  return {
    ok: false,
    code: failure.code,
    detail: failure.detail,
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    ...(failure.status === undefined ? {} : { status: failure.status }),
  };
}

/** A failure in the port's words; anything else is a defect here, whose message is this package's own text. */
function asFailure(error: unknown): Mem0StoreFailure {
  if (error instanceof Mem0StoreFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Mem0StoreFailure("unavailable", `The Mem0 integration failed: ${message.slice(0, 200)}`, "unknown");
}

function itemFailure(op: "add" | "update" | "remove", index: number, failure: Mem0StoreFailure, heldId?: string): MemoryStoreItemFailure {
  return {
    op,
    index,
    result: "failed",
    code: failure.code,
    detail: failure.detail,
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(heldId === undefined ? {} : { heldId }),
  };
}

// ---------------------------------------------------------------------------
// Addresses

/**
 * Mem0 reads a bare `*` in a filter as "any value", so a subject holding one
 * could read or erase every subject; `%` is refused alike, since Mem0 does
 * not say it is not a pattern. Core's subjects hold neither.
 */
function checkedSubject(subject: string): void {
  if (typeof subject !== "string" || subject.length === 0 || subject.includes("*") || subject.includes("%")) {
    throw new Mem0StoreFailure("rejected", "A memory subject that is empty or holds * or % cannot be addressed in Mem0, which reads them as patterns.", "no");
  }
}

function checkedKind(kind: string): void {
  if (!KINDS.includes(kind as MemoryKind)) {
    throw new Mem0StoreFailure("rejected", `Mem0 holds facts and lessons here, not ${JSON.stringify(kind)}; notebooks stay in the built-in store.`, "no");
  }
}

/** Written by this store under this namespace, with a subject and a kind it can address. */
function isOwn(memory: Mem0Memory, namespace: string): boolean {
  return (
    memory.app_id === namespace &&
    typeof memory.user_id === "string" &&
    memory.user_id.length > 0 &&
    KINDS.includes(memory.agent_id as MemoryKind)
  );
}

function ownMemories(memories: readonly Mem0Memory[], namespace: string, subject: string): Mem0Memory[] {
  return memories.filter((memory) => isOwn(memory, namespace) && memory.user_id === subject);
}

// ---------------------------------------------------------------------------
// Reading

class Reader {
  constructor(
    private readonly mem0: Mem0StoreClient,
    private readonly namespace: string,
  ) {}

  filters(subjects: readonly string[], kinds: readonly MemoryKind[]): Mem0Filters {
    const one = <T>(values: readonly T[]) => (values.length === 1 ? values[0] : { in: values });
    return { AND: [{ app_id: this.namespace }, { user_id: one(subjects) }, { agent_id: one(kinds) }] };
  }

  /**
   * Every page of what `filters` selects. `beyond: "refuse"` (the default)
   * refuses a listing past `MAX_PAGES`, for a read the port wants complete;
   * `partial` answers what it read and says so. `includeMerged` also lists
   * what Merge folded away (`Mem0ListOptions`).
   */
  async readAll(
    filters: Mem0Filters,
    options: { readonly beyond?: "refuse" | "partial"; readonly includeMerged?: boolean } = {},
  ): Promise<{ memories: Mem0Memory[]; complete: boolean }> {
    const read = new Map<string, Mem0Memory>();
    const changed = () => new Mem0StoreFailure("unavailable", "Mem0's listing changed while it was read; ask again.", "no");
    let count: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const answer = await this.mem0.listPage(filters, page, { includeMerged: options.includeMerged === true });
      // Mem0 lists newest first, so a write between two pages shifts every
      // later page: an add pushes each memory one place down (read twice), a
      // delete pulls each one place up, and one then passes from a page not
      // yet read onto one already read and is never seen. Either moves the
      // count, so a count that changed from one page to the next refuses the
      // read; an add and a delete between the same two pages keep it, but
      // leave the new memory unread, which the check at the end catches.
      if (count !== undefined && answer.count !== count) throw changed();
      count = answer.count;
      for (const memory of answer.memories) read.set(memory.id, memory);
      if (!answer.more) {
        if (read.size < answer.count) throw changed();
        return { memories: [...read.values()], complete: true };
      }
    }
    if (options.beyond === "partial") return { memories: [...read.values()], complete: false };
    throw new Mem0StoreFailure(
      "rejected",
      `Mem0 holds more than ${MAX_PAGES * MEM0_STORE_PAGE_SIZE} memories here, more than this store reads in one answer; the port wants the whole set, so none is answered.`,
      "no",
    );
  }
}

/** The entries of one subject and kind, oldest first. */
function entriesOf(memories: readonly Mem0Memory[], namespace: string, subject: string, kind: MemoryKind): MemoryStoreEntry[] {
  const own = inStoredOrder(ownMemories(memories, namespace, subject).filter((memory) => memory.agent_id === kind));
  const ids = new Set(own.map((memory) => memory.id));
  return own.map((memory) => entryOf(memory, ids));
}

/**
 * Oldest first. Mem0 lists newest first, to the second, so the listing is
 * reversed and then sorted, stably, by the time this store wrote into
 * `addedAt`; a memory without it (written before this store) goes by
 * `created_at`.
 */
function inStoredOrder(memories: readonly Mem0Memory[]): Mem0Memory[] {
  return [...memories].reverse().sort((a, b) => addedTime(a) - addedTime(b));
}

function addedTime(memory: Mem0Memory): number {
  const stamped = memory.metadata?.addedAt;
  const time = typeof stamped === "string" ? Date.parse(stamped) : Number.NaN;
  return Number.isFinite(time) ? time : timeOf(memory.created_at);
}

function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function originOf(memory: Mem0Memory): MemoryEntryOrigin {
  const origin = memory.metadata?.origin;
  // A memory under this namespace that no store here wrote came from
  // somewhere else: imported is the honest word for it.
  return typeof origin === "string" && ORIGINS.has(origin) ? (origin as MemoryEntryOrigin) : "imported";
}

function text(memory: Mem0Memory, key: "runId" | "ticketKey"): string | undefined {
  const value = memory.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * An entry in the port's fields and no other. `replacedBy` only names an
 * entry held beside it: once the memory that superseded it is gone, the older
 * one is an entry like any other again, rather than one core hides forever.
 */
function entryOf(memory: Mem0Memory, held: ReadonlySet<string>): MemoryStoreEntry {
  const runId = text(memory, "runId");
  const ticketKey = text(memory, "ticketKey");
  const written = timeOf(memory.updated_at ?? memory.created_at);
  const replacedBy = memory.replaced_by && memory.replaced_by !== memory.id && held.has(memory.replaced_by) ? memory.replaced_by : undefined;
  return {
    id: memory.id,
    subject: memory.user_id as string,
    kind: memory.agent_id as MemoryKind,
    text: memory.memory,
    origin: originOf(memory),
    ...(runId === undefined ? {} : { runId }),
    ...(ticketKey === undefined ? {} : { ticketKey }),
    ...(written > 0 ? { updatedAt: new Date(written).toISOString() } : {}),
    ...(replacedBy === undefined ? {} : { replacedBy }),
  };
}

// ---------------------------------------------------------------------------
// apply

function metadataOf(input: {
  readonly origin: MemoryEntryOrigin;
  readonly addedAt: string;
  readonly runId?: string;
  readonly ticketKey?: string;
}): Record<string, string> {
  return {
    origin: input.origin,
    addedAt: input.addedAt,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.ticketKey === undefined ? {} : { ticketKey: input.ticketKey }),
  };
}

/**
 * Which result of an add holds each text: the id Mem0 gave it, `pending`
 * when Mem0 said it queued the add (`PENDING`, no results), or null when the
 * answer does not account for it: an answer that says neither is no promise
 * that the text is queued.
 * Mem0 answers one result per message in order (an exact repeat answers the
 * memory already holding it), so position decides when the texts line up and
 * the text decides otherwise.
 */
function idsOfAdd(answer: Mem0AddAnswer, texts: readonly string[]): (string | "pending" | null)[] {
  const results = answer.results;
  if (results === undefined) return texts.map(() => (answer.status === "PENDING" ? "pending" : null));
  const same = (stored: string, sent: string) => stored === sent || stored === sent.trim();
  if (results.length === texts.length && results.every((result, index) => same(result.data.memory, texts[index] as string))) {
    return results.map((result) => result.id);
  }
  const used = new Set<number>();
  return texts.map((sent) => {
    const at = results.findIndex((result, index) => !used.has(index) && same(result.data.memory, sent));
    if (at === -1) return null;
    used.add(at);
    return (results[at] as { id: string }).id;
  });
}

async function apply(
  ctx: Context,
  mem0: Mem0StoreClient,
  reader: Reader,
  namespace: string,
  request: MemoryStoreApplyRequest,
): Promise<{ readonly ok: true; readonly outcomes: MemoryStoreApplyOutcome[] }> {
  checkedSubject(request.subject);
  checkedKind(request.kind);
  const { subject } = request;
  const kind = request.kind;
  if (request.ifVersion !== undefined) {
    throw new Mem0StoreFailure(
      "rejected",
      "Mem0 keeps no version of what a subject holds, so held answers none, and an apply carrying one is refused rather than applied without the protection it asks for.",
      "no",
    );
  }
  const outcomes: MemoryStoreApplyOutcome[] = [];
  // Whether anything this apply sent may have changed what Mem0 holds (then
  // the answer is per item, never one refusal), and every failure.
  const state: { mayHaveLanded: boolean; failures: Mem0StoreFailure[] } = { mayHaveLanded: false, failures: [] };
  const failed = (op: "add" | "update" | "remove", index: number, error: unknown, heldId?: string): MemoryStoreItemFailure => {
    const failure = asFailure(error);
    if (failure.landed === "unknown") state.mayHaveLanded = true;
    state.failures.push(failure);
    return itemFailure(op, index, failure, heldId);
  };

  // Removals and updates name ids, so what this subject and kind hold is read
  // first: an id held elsewhere (another subject, another application) is
  // missing here and never deleted, and an update keeps the entry's origin.
  const held = new Map<string, Mem0Memory>();
  if (request.remove.length > 0 || request.update.length > 0) {
    const { memories } = await reader.readAll(reader.filters([subject], [kind]));
    for (const memory of ownMemories(memories, namespace, subject)) if (memory.agent_id === kind) held.set(memory.id, memory);
  }

  async function replace(index: number, current: Mem0Memory, change: MemoryStoreUpdate, metadata: Record<string, string>): Promise<MemoryStoreApplyOutcome> {
    let answer: Mem0AddAnswer;
    try {
      answer = await mem0.addVerbatim({ texts: [change.text], userId: subject, agentId: kind, appId: namespace, metadata });
    } catch (error) {
      return failed("update", index, error);
    }
    const [id] = idsOfAdd(answer, [change.text]);
    if (id === null || id === undefined) {
      return failed("update", index, new Mem0StoreFailure("unavailable", "Mem0's answer to the replacing add did not account for the new text, so the old entry was kept.", "unknown"));
    }
    if (id === current.id) {
      // The memory already holds the new text: nothing to delete.
      state.mayHaveLanded = true;
      return { op: "update", index, result: "updated", previousId: current.id, id };
    }
    if (id !== "pending" && held.has(id)) {
      // Mem0 answered the memory already holding this exact text: it cannot
      // hold it twice, and folding the two is core's decision.
      return failed("update", index, new Mem0StoreFailure("rejected", `Mem0 already holds this text as ${id}, so the entry was left as it was.`, "no"), id);
    }
    state.mayHaveLanded = true;
    try {
      await mem0.remove(current.id, { linked: false });
    } catch (error) {
      const failure = asFailure(error);
      const where = id === "pending" ? "queued the new text" : `stored the new text as ${id}`;
      return failed(
        "update",
        index,
        new Mem0StoreFailure("unavailable", `Mem0 ${where} and did not delete the old entry: ${failure.detail}`, "unknown", failure.reason, failure.status),
      );
    }
    held.delete(current.id);
    if (id === "pending") {
      ctx.log.info({ eventId: answer.event_id ?? null }, "mem0_add_queued");
      return { op: "update", index, result: "pending", previousId: current.id };
    }
    return { op: "update", index, result: "updated", previousId: current.id, id };
  }

  for (const [index, removal] of request.remove.entries()) {
    if (!held.has(removal.id)) {
      outcomes.push({ op: "remove", index, result: "missing", id: removal.id });
      continue;
    }
    try {
      // Only what core named: a memory this one superseded stays, and core
      // sees it on its next read.
      const answer = await mem0.remove(removal.id, { linked: false });
      held.delete(removal.id);
      if (answer === "missing") {
        outcomes.push({ op: "remove", index, result: "missing", id: removal.id });
      } else {
        state.mayHaveLanded = true;
        outcomes.push({ op: "remove", index, result: "removed", id: removal.id, reason: removal.reason });
      }
    } catch (error) {
      outcomes.push(failed("remove", index, error));
    }
  }

  const stamp = { runId: request.runId, ticketKey: request.ticketKey };
  for (const [index, change] of request.update.entries()) {
    const current = held.get(change.id);
    if (!current) {
      outcomes.push({ op: "update", index, result: "missing", id: change.id });
      continue;
    }
    const metadata = metadataOf({ origin: originOf(current), addedAt: new Date(addedTime(current)).toISOString(), ...stamp });
    try {
      const answer = await mem0.update(current.id, change.text, metadata);
      if (answer === "missing") {
        outcomes.push({ op: "update", index, result: "missing", id: change.id });
        continue;
      }
      state.mayHaveLanded = true;
      outcomes.push({ op: "update", index, result: "updated", previousId: current.id, id: answer.id });
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code !== "rejected") {
        outcomes.push(failed("update", index, failure));
        continue;
      }
      // Mem0 would not edit this memory in place (the documentation says so
      // of an immutable one), so it is replaced: the new text first, the old
      // entry second, so a failure between leaves the old text held.
      outcomes.push(await replace(index, current, change, metadata));
    }
  }

  // Additions, one add per origin (metadata is per call), in batches.
  const byOrigin = new Map<MemoryEntryOrigin, { index: number; text: string }[]>();
  for (const [index, addition] of request.add.entries()) {
    byOrigin.set(addition.origin, [...(byOrigin.get(addition.origin) ?? []), { index, text: addition.text }]);
  }
  for (const [origin, items] of byOrigin) {
    for (let start = 0; start < items.length; start += ADD_BATCH) {
      const batch = items.slice(start, start + ADD_BATCH);
      const texts = batch.map((item) => item.text);
      let answer: Mem0AddAnswer;
      try {
        answer = await mem0.addVerbatim({
          texts,
          userId: subject,
          agentId: kind,
          appId: namespace,
          metadata: metadataOf({ origin, addedAt: addedAtNow(), ...stamp }),
        });
      } catch (error) {
        for (const item of batch) outcomes.push(failed("add", item.index, error));
        continue;
      }
      state.mayHaveLanded = true;
      const ids = idsOfAdd(answer, texts);
      if (ids.includes("pending")) ctx.log.info({ eventId: answer.event_id ?? null, items: batch.length }, "mem0_add_queued");
      batch.forEach((item, at) => {
        const id = ids[at];
        if (id === "pending") outcomes.push({ op: "add", index: item.index, result: "pending" });
        else if (typeof id === "string") outcomes.push({ op: "add", index: item.index, result: "added", id });
        else {
          outcomes.push(
            failed("add", item.index, new Mem0StoreFailure("unavailable", "Mem0's answer to the add did not account for this text, so whether it was stored is not known.", "unknown")),
          );
        }
      });
    }
  }

  // One refusal only when nothing can have been applied and one refusal
  // tells it truly: every item failed, each with Mem0's answer that it did not
  // land, none names an entry (`heldId`) that core needs to decide what to
  // keep, and all for one cause (a bad request and a rate limit are answered
  // item by item, so core asks again for what is worth asking again).
  const collapses = outcomes.every((outcome) => outcome.result === "failed" && outcome.heldId === undefined);
  const [first] = state.failures;
  const alike = state.failures.every((failure) => failure.code === first?.code && failure.reason === first.reason && failure.status === first.status);
  if (first !== undefined && !state.mayHaveLanded && collapses && alike) {
    throw first;
  }
  outcomes.sort((a, b) => ORDER.indexOf(a.op) - ORDER.indexOf(b.op) || a.index - b.index);
  return { ok: true, outcomes };
}

const ORDER = ["remove", "update", "add"] as const;
