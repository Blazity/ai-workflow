/**
 * The `memory` port on Mem0.
 *
 * HOW CORE'S ADDRESSES MAP ONTO MEM0 (decided once; the README says why):
 *
 * | Core                       | Mem0                                  |
 * |----------------------------|---------------------------------------|
 * | this integration           | `app_id` = `MEM0_NAMESPACE`           |
 * | `subject.key`              | `user_id`, exactly                    |
 * | scope                      | `agent_id`: `facts`, `lessons`, `notebook/<name>` |
 * | `runId`, `ticketKey`       | `metadata`, provenance only           |
 *
 * Every read, listing and delete carries all of the entity fields it means,
 * the namespace always, so another application's memories in the same Mem0
 * project never reach a prompt, the memory screen or an erasure. `run_id` is
 * never used: it would file each run's knowledge where the next never looks.
 *
 * Mem0's own add (infer true) is asynchronous, rewords through its extraction
 * model and only appends. So every write here is a Direct Import (infer false):
 * synchronous, verbatim, one memory per item, and this adapter does the
 * reconciling Mem0 leaves undone: it skips an item it already holds, deletes by
 * id what a run refuted, and replaces a notebook by adding the new text and
 * then deleting the old one.
 *
 * `recall` and `observe` never throw: each is one try around its whole body,
 * and `answerOf` turns anything caught into an answer.
 */
import type {
  IntegrationContext,
  MemoryAdapter,
  MemoryObserveRequest,
  MemoryRecall,
  MemoryRecallRequest,
  MemoryScope,
  MemoryStoreAdapter,
  MemoryStoredDocumentRef,
  MemoryStoredSummary,
  MemoryWrite,
} from "@integrations/sdk";
import {
  MEM0_PAGE_SIZE,
  Mem0Failure,
  mem0Client,
  type Mem0Client,
  type Mem0Filters,
  type StoredMemory,
} from "./client";
import type { manifest } from "./manifest";

type Context = IntegrationContext<typeof manifest>;

/**
 * The `app_id` every memory this integration writes carries, and every read
 * requires. Permanent: changing it orphans everything already stored.
 */
export const MEM0_NAMESPACE = "ai-workflow";

/**
 * How many pages (of 200) one read goes through. 1,000 memories under one
 * subject and scope is far past what one prompt carries (16 KiB of lines of
 * at most 200 characters is a few hundred), and bounds the time a read takes.
 */
const MAX_PAGES_PER_SCOPE = 5;

/** The memory screen's listing reads further: 2,000 memories, then says it stopped. */
const MAX_PAGES_PER_LISTING = 10;

/** What core writes in place of a known secret inside a quoted entry (see `MemoryObservation.refuted`). */
const REDACTION_MARKER = "[REDACTED:configured_secret]";

/** How each memory came to be, kept in metadata so a recall can put derived entries first. */
type Origin = "derived" | "learned" | "notebook";

export function mem0Memory(ctx: Context): MemoryAdapter {
  const mem0 = mem0Client(ctx);
  return {
    async recall(request) {
      try {
        return await recall(mem0, request);
      } catch (error) {
        return answerOf(error);
      }
    },
    async observe(request) {
      try {
        return await observe(mem0, request);
      } catch (error) {
        return answerOf(error);
      }
    },
    store: store(mem0),
  };
}

/** The one exit for a failure on the run path. */
function answerOf(error: unknown): { ok: false; code: Mem0Failure["code"]; detail: string } {
  if (error instanceof Mem0Failure) return { ok: false, code: error.code, detail: error.detail };
  // Only a defect in this package reaches here; its message is its own text,
  // never a response body.
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: "unavailable", detail: `The Mem0 integration failed: ${message.slice(0, 200)}` };
}

// ---------------------------------------------------------------------------
// Addresses

/** Core's scope as the one `agent_id` it is filed under. Never parsed back on the run path. */
function scopeId(scope: MemoryScope): string {
  return scope.kind === "notebook" ? `notebook/${scope.name}` : scope.kind;
}

/**
 * Mem0 reads a bare `*` in a filter as "any value", and a delete by filter as
 * "every". Core's keys never contain one, so a value that does is refused
 * before it can reach a filter.
 */
function checkedAddress(value: string, what: string): string {
  if (value.length === 0 || value.includes("*")) {
    throw new Mem0Failure("rejected", `A memory ${what} that is empty or contains * cannot be addressed in Mem0.`);
  }
  return value;
}

function pairFilters(subjectKey: string, agentId: string): Mem0Filters {
  return { AND: [{ app_id: MEM0_NAMESPACE }, { user_id: subjectKey }, { agent_id: agentId }] };
}

function filtersFor(subjectKey: string, scope: MemoryScope): Mem0Filters {
  const agentId = scopeId(scope);
  checkedAddress(subjectKey, "subject");
  checkedAddress(agentId, "notebook name");
  return pairFilters(subjectKey, agentId);
}

/** Everything under `filters`, up to `maxPages`; `complete` is false when Mem0 had more. */
async function readAll(
  mem0: Mem0Client,
  filters: Mem0Filters,
  maxPages: number,
): Promise<{ memories: StoredMemory[]; complete: boolean }> {
  const memories: StoredMemory[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const answer = await mem0.listPage(filters, page);
    memories.push(...answer.memories);
    if (!answer.more) return { memories, complete: true };
  }
  return { memories, complete: false };
}

// ---------------------------------------------------------------------------
// recall

async function recall(mem0: Mem0Client, request: MemoryRecallRequest): Promise<MemoryRecall> {
  const filters = filtersFor(request.subject.key, request.scope);
  const { memories } = await readAll(mem0, filters, MAX_PAGES_PER_SCOPE);
  if (memories.length === 0) return { ok: true, held: false, entries: [], rendering: "" };
  const excluded = new Set(request.exclude ?? []);

  if (request.scope.kind === "notebook") {
    const text = newest(memories).memory;
    const entries = excluded.has(text) ? [] : [{ text }];
    return { ok: true, held: true, entries, rendering: entries[0]?.text ?? "" };
  }

  // Get-all's order is not documented, so the order is this adapter's: what
  // a manifest said first (nothing else reproduces it), then newest first.
  const entries = [...memories]
    .sort((a, b) => Number(originOf(b) === "derived") - Number(originOf(a) === "derived") || timeOf(b) - timeOf(a))
    .map((memory) => memory.memory)
    .filter((text, index, all) => !excluded.has(text) && all.indexOf(text) === index)
    .map((text) => ({ text }));
  return { ok: true, held: true, entries, rendering: entries.map((entry) => `- ${entry.text}`).join("\n") };
}

// ---------------------------------------------------------------------------
// observe

async function observe(mem0: Mem0Client, request: MemoryObserveRequest): Promise<MemoryWrite> {
  const { observation, scope } = request;
  if ((observation.kind === "document") !== (scope.kind === "notebook")) {
    throw new Mem0Failure("rejected", `A ${scope.kind} scope does not take a ${observation.kind} observation.`);
  }
  const filters = filtersFor(request.subject.key, scope);
  const held = await readAll(mem0, filters, MAX_PAGES_PER_SCOPE);
  if (!held.complete) {
    // Without the whole list, a learned item may already be held and a
    // refuted one may be on a page never read.
    throw new Mem0Failure(
      "rejected",
      `Mem0 holds more than ${MAX_PAGES_PER_SCOPE * MEM0_PAGE_SIZE} memories under this subject and scope, more than this integration reconciles in one step.`,
    );
  }
  const target = { userId: request.subject.key, agentId: scopeId(scope) };
  const metadata = provenance(request);

  if (observation.kind === "document") {
    return replaceNotebook(mem0, held.memories, observation.text, target, {
      ...metadata,
      origin: "notebook",
      ...(observation.sourceTruncated ? { truncated: true } : {}),
    });
  }

  if (observation.onlyIfEmpty && held.memories.length > 0) {
    return { ok: true, stored: false, removed: 0, dropped: 0, remaining: held.memories.length };
  }

  // Forget what the run refuted: find each by its exact words, delete by id.
  const doomed = held.memories.filter((memory) => observation.refuted.some((quote) => quotes(quote, memory.memory)));
  let removed = 0;
  for (const memory of doomed) {
    if ((await mem0.deleteById(memory.id)) === "deleted") removed += 1;
  }

  // Store what is new: not refuted by this same run, not already held.
  const heldTexts = new Set(held.memories.filter((memory) => !doomed.includes(memory)).map((memory) => memory.memory));
  const fresh = [...new Set(observation.learned)].filter(
    (item) => !heldTexts.has(item) && !observation.refuted.some((quote) => quotes(quote, item)),
  );
  let added = 0;
  if (fresh.length > 0) {
    const answer = await mem0.addVerbatim({
      ...target,
      appId: MEM0_NAMESPACE,
      messages: fresh.map((content) => ({ role: "user", content })),
      metadata: { ...metadata, origin: observation.derived ? "derived" : "learned" },
    });
    added = answer.results?.length ?? fresh.length;
  }
  return {
    ok: true,
    stored: fresh.length > 0 || removed > 0,
    removed,
    dropped: 0,
    remaining: held.memories.length - removed + added,
  };
}

/**
 * The notebook's text replaces what was held. Order matters: the new version
 * is added and confirmed before any old one is deleted, so a failure in
 * between leaves two versions (recall reads the newest) and never none.
 */
async function replaceNotebook(
  mem0: Mem0Client,
  held: readonly StoredMemory[],
  text: string,
  target: { readonly userId: string; readonly agentId: string },
  metadata: Readonly<Record<string, string | boolean>>,
): Promise<MemoryWrite> {
  // Mem0 deduplicates an exact repeat in the same scope, so adding the text it
  // already holds would return nothing new, and deleting "the old version"
  // afterwards would delete the only copy. Keep that one and clear the rest.
  const same = held.filter((memory) => memory.memory === text);
  if (same.length > 0) {
    const keep = newest(same);
    const removed = await deleteAll(mem0, held.filter((memory) => memory !== keep));
    return { ok: true, stored: removed > 0, removed, dropped: 0, remaining: held.length - removed };
  }

  const answer = await mem0.addVerbatim({
    ...target,
    appId: MEM0_NAMESPACE,
    messages: [{ role: "user", content: text }],
    metadata,
  });
  const stored = answer.results?.[0];
  if (!stored) {
    // Accepted without a result: queued, not confirmed. The previous version
    // stays until a later write confirms a new one; recall reads the newest.
    return { ok: true, stored: true, removed: 0, dropped: 0, remaining: held.length };
  }
  if (stored.data.memory !== text && stored.data.memory !== text.trim()) {
    // Mem0 kept something other than the text it was given (shortened, most
    // likely). A notebook that ends early with nothing saying why is worse
    // than the previous one, so take it back out and keep the previous.
    await mem0.deleteById(stored.id);
    throw new Mem0Failure(
      "rejected",
      `Mem0 stored ${byteLength(stored.data.memory)} of the notebook's ${byteLength(text)} bytes, so the previous version was kept.`,
    );
  }
  const removed = await deleteAll(
    mem0,
    held.filter((memory) => memory.id !== stored.id),
  );
  return { ok: true, stored: true, removed, dropped: 0, remaining: held.length - removed + 1 };
}

async function deleteAll(mem0: Mem0Client, memories: readonly StoredMemory[]): Promise<number> {
  let removed = 0;
  for (const memory of memories) {
    if ((await mem0.deleteById(memory.id)) === "deleted") removed += 1;
  }
  return removed;
}

function provenance(request: MemoryObserveRequest): Record<string, string> {
  return {
    runId: request.runId,
    ...(request.ticketKey === null ? {} : { ticketKey: request.ticketKey }),
  };
}

/**
 * Whether a refuted quote names this stored text: exactly, except that core's
 * redaction marker in the quote stands for one run of non-space characters
 * (the secret it replaced, or the marker itself when that is what was stored).
 */
export function quotes(quote: string, stored: string): boolean {
  if (!quote.includes(REDACTION_MARKER)) return quote === stored;
  const pattern = quote
    .split(REDACTION_MARKER)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\S+");
  return new RegExp(`^${pattern}$`, "u").test(stored);
}

function originOf(memory: StoredMemory): Origin | undefined {
  const origin = memory.metadata?.origin;
  return origin === "derived" || origin === "learned" || origin === "notebook" ? origin : undefined;
}

function timeOf(memory: StoredMemory): number {
  const time = Date.parse(memory.created_at);
  return Number.isNaN(time) ? 0 : time;
}

function updatedOf(memory: StoredMemory): number {
  const time = Date.parse(memory.updated_at ?? memory.created_at);
  return Number.isNaN(time) ? timeOf(memory) : time;
}

/** The latest by creation; on a tie, the one Mem0 listed last. */
function newest(memories: readonly StoredMemory[]): StoredMemory {
  return memories.reduce((latest, memory) => (timeOf(memory) >= timeOf(latest) ? memory : latest));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// ---------------------------------------------------------------------------
// The admin half: one document per (subject, scope), as the SDK recommends.

/** The pair a document is addressed by, or null for anything `list` could not have produced. */
function documentPair(ref: MemoryStoredDocumentRef): { subjectKey: string; agentId: string } | null {
  const { subjectKey, docPath } = ref;
  if (subjectKey.length === 0 || subjectKey.includes("*") || docPath.includes("*")) return null;
  const known = docPath === "facts" || docPath === "lessons" || /^notebook\/.+/su.test(docPath);
  return known ? { subjectKey, agentId: docPath } : null;
}

/** What the memory screen shows for one document: what `recall` would render. */
function contentOf(agentId: string, memories: readonly StoredMemory[]): string {
  if (agentId.startsWith("notebook/")) return newest(memories).memory;
  return [...memories]
    .sort((a, b) => Number(originOf(b) === "derived") - Number(originOf(a) === "derived") || timeOf(b) - timeOf(a))
    .map((memory) => `- ${memory.memory}`)
    .join("\n");
}

function store(mem0: Mem0Client): MemoryStoreAdapter {
  return {
    async list(options) {
      const conditions: Record<string, unknown>[] = [{ app_id: MEM0_NAMESPACE }];
      if (options.subjectKey !== undefined) {
        if (options.subjectKey.length === 0 || options.subjectKey.includes("*")) return { documents: [], complete: true };
        conditions.push({ user_id: options.subjectKey });
      }
      if (options.ticketKey !== undefined) {
        // Metadata filters take a bare value as equality; a `*` in one is not
        // documented either way, and no ticket key carries one.
        if (options.ticketKey.length === 0 || options.ticketKey.includes("*")) return { documents: [], complete: true };
        conditions.push({ metadata: { ticketKey: options.ticketKey } });
      }
      const read = await readAll(mem0, { AND: conditions }, MAX_PAGES_PER_LISTING);

      const groups = new Map<string, { subjectKey: string; agentId: string; memories: StoredMemory[] }>();
      for (const memory of read.memories) {
        // A memory under this namespace without both fields was not written by
        // this integration and has no pair `read` could answer.
        if (!memory.user_id || !memory.agent_id) continue;
        const key = JSON.stringify([memory.user_id, memory.agent_id]);
        const group = groups.get(key) ?? { subjectKey: memory.user_id, agentId: memory.agent_id, memories: [] };
        group.memories.push(memory);
        groups.set(key, group);
      }
      const documents: MemoryStoredSummary[] = [...groups.values()]
        .map(({ subjectKey, agentId, memories }) => {
          const latest = memories.reduce((a, b) => (updatedOf(b) >= updatedOf(a) ? b : a));
          const oldest = memories.reduce((a, b) => (timeOf(b) < timeOf(a) ? b : a));
          const ticketKey = latest.metadata?.ticketKey;
          const runId = latest.metadata?.runId;
          return {
            subjectKey,
            docPath: agentId,
            ticketKey: typeof ticketKey === "string" ? ticketKey : null,
            bytes: byteLength(contentOf(agentId, memories)),
            sourceRunId: typeof runId === "string" ? runId : "",
            createdAt: new Date(timeOf(oldest)),
            updatedAt: new Date(updatedOf(latest)),
          };
        })
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      const limited = options.limit === undefined ? documents : documents.slice(0, options.limit);
      return { documents: limited, complete: read.complete && limited.length === documents.length };
    },

    async read(ref) {
      const pair = documentPair(ref);
      if (!pair) return null;
      const { memories } = await readAll(mem0, pairFilters(pair.subjectKey, pair.agentId), MAX_PAGES_PER_SCOPE);
      if (memories.length === 0) return null;
      const latest = memories.reduce((a, b) => (updatedOf(b) >= updatedOf(a) ? b : a));
      const content = contentOf(pair.agentId, memories);
      const runId = latest.metadata?.runId;
      return {
        content,
        bytes: byteLength(content),
        updatedAt: new Date(updatedOf(latest)),
        sourceRunId: typeof runId === "string" ? runId : "",
      };
    },

    async forget(ref) {
      const pair = documentPair(ref);
      if (!pair) return false;
      // Deleted one id at a time, because Mem0's delete by filter runs in the
      // background and cannot say what it removed. Read again until nothing is
      // left, since each delete shifts the pages.
      let removed = 0;
      for (let round = 0; round < MAX_PAGES_PER_SCOPE; round += 1) {
        const page = await mem0.listPage(pairFilters(pair.subjectKey, pair.agentId), 1);
        if (page.memories.length === 0) return removed > 0;
        removed += await deleteAll(mem0, page.memories);
      }
      throw new Error("Mem0 still held memories under this document after five rounds of deletes; erase it again.");
    },
  };
}
