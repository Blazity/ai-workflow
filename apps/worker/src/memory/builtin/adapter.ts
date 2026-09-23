/**
 * The built-in memory provider: `builtin`.
 *
 * It is a core module rather than an `integrations/*` package because it needs
 * core's database, and an integration gets none (ADR-010 decision 10). It is
 * the provider of a deployment that has connected nothing, which is the
 * default and the overwhelmingly common case, so connecting a memory
 * integration REPLACES this provider rather than supplying the first one.
 *
 * WHAT MOVED HERE, AND WHY IT BELONGS HERE. Parsing a stored document,
 * deduplicating, removing what a run disproved, stamping provenance, evicting
 * down to a bound and writing the result back under a compare-and-swap used to
 * be spread across three step files. All of it is one provider's answer to
 * "here is what this run learned", and a hosted memory engine answers the same
 * question with machinery of its own. Core no longer spells a document, a
 * version or a row, and the concurrency safety did not leave the system: it
 * stopped being core's vocabulary.
 *
 * `recall` and `observe` NEVER THROW. Both answer, because the port promises
 * that and because memory must not be able to change a run's outcome. A
 * database error and an oversized document are both answers there.
 *
 * It does not scrub secrets. Every observation reaches every provider, this
 * one included, with this deployment's secrets already taken out, in one place
 * (`withoutKnownSecrets` in `engine/support/memory-runtime.ts`).
 *
 * `store` is the other half and it DOES throw, which the port also says: its
 * three methods have no failure shape to answer with, so the alternative is to
 * report a database outage as an empty listing. `services/memory/memory-documents.ts`
 * is where those throws are caught and turned into a refusal a screen can
 * print.
 *
 * Workflow-scope safe: the pure format modules are imported statically, and
 * everything that reaches Node or the database is a deferred import inside a
 * method, exactly as the steps that call this do.
 */
import type {
  MemoryAdapter,
  MemoryEntry,
  MemoryObserveRequest,
  MemoryRecall,
  MemoryRecallRequest,
  MemoryScope,
  MemoryStoreAdapter,
  MemoryStoredDocumentRef,
  MemoryWrite,
} from "@integrations/sdk";
import { prepareMemoryContent, utf8Bytes } from "../content.js";
import {
  mergeRepoMemoryItems,
  parseRepoMemoryDocument,
  renderRepoMemoryDocument,
  repoMemoryComparisonKey,
  stripRepoMemoryProvenance,
  type RepoMemoryDocKind,
  type RepoMemoryItem,
} from "../repo-memory.js";

/** The id this provider is known by. Written into no row: it identifies the
 *  provider, not the data, and the data is addressed by subject and scope. */
export const BUILTIN_MEMORY_PROVIDER_ID = "builtin";

/**
 * What an admin sees when this deployment's memory is the one we ship.
 *
 * "Built-in memory" rather than a product name, because it is not a product an
 * admin chose, connected or can go and look at: it is what memory does here
 * when nobody has decided otherwise, and naming it after us would invite
 * somebody to look for its settings page.
 */
export const BUILTIN_MEMORY_PROVIDER_NAME = "Built-in memory";

/**
 * Per stored facts or lessons document. The number and the reasoning behind it
 * moved here unchanged from `repo-memory-steps.ts`: these documents are
 * injected into every prompt for the repository, and the item caps below, not
 * this one, are what bound a mature document.
 */
const MAX_DOC_BYTES = 12 * 1024;
const FACTS_MAX_ITEMS = 40;
const LESSONS_MAX_ITEMS = 30;
/**
 * Compare-and-swap rounds per document. neon-http has no transactions, so the
 * version predicate is what makes the read-merge-write safe; a document under
 * contention from more writers than this keeps its winner and loses only this
 * run's observation, which is reported as `contended` rather than swallowed.
 */
const MAX_WRITE_ATTEMPTS = 3;

/** Exactly the path the agent reads and commits, relative to its cwd. */
const NOTEBOOK_DIR = "ai-workflow/memory";
/** The directory older runs wrote to. Read as a fallback so a document an
 *  earlier run stored is not orphaned; never written. */
const LEGACY_NOTEBOOK_DIR = "blazebot/memory";

/** The built-in provider, as core resolves it. */
export function builtinMemoryAdapter(): MemoryAdapter {
  return {
    recall: builtinRecall,
    observe: builtinObserve,
    store: builtinMemoryStore,
  };
}

/**
 * The address a scope has in this store. The three words and both notebook
 * directories are written into rows and into repositories we do not own, so
 * none of them may be renamed.
 */
function builtinDocPath(scope: MemoryScope): string {
  if (scope.kind === "notebook") return notebookDocPath(scope.name);
  return scope.kind;
}

function notebookDocPath(name: string): string {
  // A name may never walk out of the memory directory.
  if (name.split("/").includes("..")) throw new Error("invalid memory task id");
  return `${NOTEBOOK_DIR}/${name}.md`;
}

/** The document key an older run wrote under. Read only, for backward-compat. */
function legacyNotebookDocPath(name: string): string {
  if (name.split("/").includes("..")) throw new Error("invalid memory task id");
  return `${LEGACY_NOTEBOOK_DIR}/${name}.md`;
}

async function builtinRecall(request: MemoryRecallRequest): Promise<MemoryRecall> {
  try {
    const { getConnectedMemoryDocument } = await import("../../db/repositories/memory.js");
    if (request.scope.kind === "notebook") {
      // Dual-read, and the new key first: whatever is found is handed back at
      // the new address, and the write path stores it under the new key, so a
      // document written before the rename migrates forward by being used.
      const stored =
        (await getConnectedMemoryDocument(
          request.subject.key,
          notebookDocPath(request.scope.name),
        )) ??
        (await getConnectedMemoryDocument(
          request.subject.key,
          legacyNotebookDocPath(request.scope.name),
        ));
      if (!stored) return { ok: true, held: false, entries: [], rendering: "" };
      // A notebook is one thing this store remembers about this work, so it is
      // one entry. Reporting zero entries for a notebook that has text would
      // read to a caller as "nothing is stored here", which is the answer that
      // makes a seed overwrite somebody's document.
      const entries: readonly MemoryEntry[] =
        stored.content.trim().length === 0 ? [] : [{ text: stored.content }];
      return { ok: true, held: true, entries, rendering: stored.content };
    }

    const kind: RepoMemoryDocKind = request.scope.kind;
    const stored = await getConnectedMemoryDocument(request.subject.key, kind);
    if (!stored) return { ok: true, held: false, entries: [], rendering: "" };
    const items = parseRepoMemoryDocument(stored.content);
    const excluded = new Set(
      (request.exclude ?? [])
        .map((text) => repoMemoryComparisonKey(text))
        .filter((key) => key.length > 0),
    );
    const surviving =
      excluded.size === 0
        ? items
        : items.filter((item) => !excluded.has(repoMemoryComparisonKey(item.text)));
    // Provenance is this store's bookkeeping, not knowledge, so it is stripped
    // before anything leaves: an agent that saw a run id would repeat it back.
    // A document that lost nothing is handed over byte for byte as stored; only
    // a filtered one is re-rendered, and `runId: null` keeps that render
    // correct on its own rather than relying on the strip that follows it.
    const rendering =
      surviving.length === 0
        ? ""
        : stripRepoMemoryProvenance(
            surviving.length === items.length
              ? stored.content
              : renderRepoMemoryDocument({
                  subject: request.subject.label,
                  kind,
                  items: surviving.map((item) => ({ text: item.text, runId: null })),
                }),
          );
    return {
      ok: true,
      held: true,
      entries: surviving.map((item) => ({ text: item.text })),
      rendering,
    };
  } catch (error) {
    return { ok: false, code: "unavailable", detail: failureDetail(error) };
  }
}

async function builtinObserve(request: MemoryObserveRequest): Promise<MemoryWrite> {
  try {
    if (request.observation.kind === "document") {
      return await storeDocument(
        request,
        request.observation.text,
        request.observation.sourceTruncated === true,
      );
    }
    if (request.scope.kind === "notebook") {
      // A notebook has no items to reconcile. Refusing rather than inventing a
      // merge: the agent is its only author, and a caller that reached here
      // meant to store what the agent wrote.
      return {
        ok: false,
        code: "rejected",
        detail: "the built-in store keeps a notebook as one document, so it takes no item observations",
      };
    }
    return await storeItems(request, request.scope.kind, request.observation);
  } catch (error) {
    return { ok: false, code: writeFailureCode(error), detail: failureDetail(error) };
  }
}

/**
 * Which of the two refusals a write threw.
 *
 * `unavailable` is the default because almost everything that throws on this
 * path is the database being unreachable, and that is worth retrying. A
 * document the store will never accept is `rejected` instead: the SDK says
 * `unavailable` is worth retrying, so reporting an oversized document that way
 * tells a caller to come back and be refused again, and on the distill path
 * that costs another model call.
 *
 * Read off a property rather than an imported class: this runs in a catch,
 * where a deferred import can fail cold.
 */
function writeFailureCode(error: unknown): "unavailable" | "rejected" {
  return (error as { code?: unknown } | null | undefined)?.code === "memory_document_too_large"
    ? "rejected"
    : "unavailable";
}

/**
 * The whole document, as the agent wrote it. Last writer wins, deliberately:
 * one run owns one piece of work's notebook, and the version predicate that
 * protects a shared document would only turn "the run wrote it twice" into a
 * lost capture.
 */
async function storeDocument(
  request: MemoryObserveRequest,
  text: string,
  sourceTruncated: boolean,
): Promise<MemoryWrite> {
  const { MAX_MEMORY_DOCUMENT_BYTES, upsertConnectedMemoryDocument } = await import(
    "../../db/repositories/memory.js"
  );
  // `sourceTruncated` is what makes a document the caller already had to cut
  // carry the marker. Without it a prefix that happens to fit the cap is
  // indistinguishable from a whole document, and the stored text would end mid
  // sentence with nothing saying why.
  const prepared = prepareMemoryContent(text, MAX_MEMORY_DOCUMENT_BYTES, sourceTruncated);
  if (prepared.truncated) {
    // Stored truncated rather than dropped, which is what this store has
    // always done. The warning is the record that it happened.
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      {
        subjectKey: request.subject.key,
        docPath: builtinDocPath(request.scope),
        maxBytes: MAX_MEMORY_DOCUMENT_BYTES,
      },
      "memory_document_truncated",
    );
  }
  await upsertConnectedMemoryDocument({
    subjectKey: request.subject.key,
    // Always the new address, never the legacy one: a document read from the
    // old key migrates forward the first time a run stores it.
    docPath: builtinDocPath(request.scope),
    ticketKey: request.ticketKey,
    content: prepared.content,
    sourceRunId: request.runId,
  });
  return { ok: true, stored: true, removed: 0, dropped: 0, remaining: 1 };
}

/**
 * Distilled assertions, merged into what is already there under a
 * compare-and-swap.
 *
 * Read, merge and render are redone on every attempt: a lost swap means
 * another writer replaced the document, and re-issuing bytes rendered against
 * the old one would delete whatever it had added. Retractions are replayed on
 * every attempt too, so a stale reassertion cannot win by arriving second.
 */
async function storeItems(
  request: MemoryObserveRequest,
  kind: RepoMemoryDocKind,
  observation: Extract<MemoryObserveRequest["observation"], { kind: "items" }>,
): Promise<MemoryWrite> {
  const { getConnectedMemoryDocument, upsertConnectedMemoryDocument } = await import(
    "../../db/repositories/memory.js"
  );
  const stored = await getConnectedMemoryDocument(request.subject.key, kind);

  if (observation.onlyIfEmpty) {
    // Create only. A document that appears between the read and the insert
    // belongs to whoever wrote it: what a run distilled is strictly better than
    // what a deterministic seed derives, so it is never merged into.
    if (stored) return { ok: true, stored: false, removed: 0, dropped: 0, remaining: 0 };
    const items: RepoMemoryItem[] = observation.learned.map((text) => ({
      text,
      runId: request.runId,
      ...(observation.derived === true ? { pinned: true as const } : {}),
    }));
    if (items.length === 0) {
      return { ok: true, stored: false, removed: 0, dropped: 0, remaining: 0 };
    }
    const prepared = prepared12k(request.subject.label, kind, items);
    if (!prepared.ok) return prepared.write;
    const created = await upsertConnectedMemoryDocument({
      subjectKey: request.subject.key,
      docPath: kind,
      ticketKey: request.ticketKey,
      content: prepared.content,
      sourceRunId: request.runId,
      expectedVersion: 0,
    });
    return {
      ok: true,
      stored: created.applied,
      removed: 0,
      dropped: 0,
      remaining: created.applied ? items.length : 0,
    };
  }

  let existing = stored ? parseRepoMemoryDocument(stored.content) : [];
  // `stored?.version ?? 0` is the required idiom: the key may never be present
  // with an undefined value, and 0 is what means "create it".
  let expectedVersion = stored?.version ?? 0;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    /**
     * FORGETTING ON REQUEST NEVER COSTS MORE THAN WHAT WAS ASKED FOR.
     *
     * An observation that asserts nothing is a retraction: something this run
     * proved false. Applying the caps to it as well would let a run that meant
     * to delete one stale line also delete everything a document holds beyond
     * the bound, which happens exactly on a document stored under an older,
     * larger cap. That is a destructive surprise nobody asked for, and the
     * next observation that actually adds something trims it anyway.
     *
     * So a pure retraction is merged against a bound no smaller than what is
     * already stored. An over-cap document is then refused by the size check
     * below rather than silently trimmed, which is what this store did before
     * the merge moved here.
     */
    const adds = observation.learned.length > 0;
    const cap = kind === "facts" ? FACTS_MAX_ITEMS : LESSONS_MAX_ITEMS;
    const merged = mergeRepoMemoryItems({
      existing,
      candidates: observation.learned,
      contradicted: observation.refuted,
      runId: request.runId,
      maxItems: adds ? cap : Math.max(cap, existing.length),
      maxBytes: adds
        ? MAX_DOC_BYTES
        : Math.max(MAX_DOC_BYTES, storedBytes(request.subject.label, kind, existing)),
      subject: request.subject.label,
      kind,
    });
    if (sameItems(merged.items, existing)) {
      return {
        ok: true,
        stored: false,
        removed: 0,
        dropped: 0,
        remaining: merged.items.length,
      };
    }
    const prepared = prepared12k(request.subject.label, kind, merged.items);
    if (!prepared.ok) return prepared.write;
    const result = await upsertConnectedMemoryDocument({
      subjectKey: request.subject.key,
      docPath: kind,
      ticketKey: request.ticketKey,
      content: prepared.content,
      sourceRunId: request.runId,
      expectedVersion,
    });
    if (result.applied) {
      // Counts only once the swap applied: a contended or refused write deleted
      // nothing, so reporting its counts would name a loss this store never
      // took.
      return {
        ok: true,
        stored: true,
        removed: merged.removed,
        dropped: merged.dropped,
        remaining: merged.items.length,
      };
    }
    if (attempt === MAX_WRITE_ATTEMPTS) {
      // Bounded on purpose: an unbounded loop would spin against a hot subject
      // for as long as the runs keep coming, and one lost observation costs
      // far less than that.
      return {
        ok: false,
        code: "contended",
        detail: `another writer won this document ${MAX_WRITE_ATTEMPTS} times, so this run's observation was not stored`,
      };
    }
    const fresh = await getConnectedMemoryDocument(request.subject.key, kind);
    existing = fresh ? parseRepoMemoryDocument(fresh.content) : [];
    expectedVersion = fresh?.version ?? 0;
  }
  // Unreachable: the loop returns on every path. Present so the function has
  // one type rather than an implicit undefined.
  return { ok: false, code: "contended", detail: "the document could not be written" };
}

/** What the items already stored render to, so a retraction is bounded by what
 *  is there rather than by what this store would accept as new. */
function storedBytes(
  subject: string,
  kind: RepoMemoryDocKind,
  items: readonly RepoMemoryItem[],
): number {
  return utf8Bytes(renderRepoMemoryDocument({ subject, kind, items }));
}

type PreparedDocument =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly write: MemoryWrite };

/**
 * Render and size one facts or lessons document.
 *
 * The merge already sized the items under the cap, so a cut here is reached
 * only by a pure retraction on a document stored under an older, larger cap
 * (see "forgetting on request" in `storeItems`). It is `rejected` rather than
 * a silent trim: the cut would land inside a bullet or its provenance comment,
 * storing a mangled document is worse than storing none, and the next run
 * that adds something trims it properly.
 */
function prepared12k(
  subject: string,
  kind: RepoMemoryDocKind,
  items: readonly RepoMemoryItem[],
): PreparedDocument {
  const prepared = prepareMemoryContent(
    renderRepoMemoryDocument({ subject, kind, items }),
    MAX_DOC_BYTES,
    false,
  );
  if (prepared.truncated) {
    return {
      ok: false,
      write: {
        ok: false,
        code: "rejected",
        detail: `the document would be larger than the ${MAX_DOC_BYTES / 1024} KiB this store holds, so it was not stored`,
      },
    };
  }
  return { ok: true, content: prepared.content };
}

/**
 * Provenance counts as a difference, not just text: a run that only confirms
 * stored items produces an identical text list but a fresher run id, and
 * skipping that write would leave the eviction order frozen at whatever last
 * changed the text. The price is one extra write per confirming run.
 *
 * The mark is deliberately NOT compared, which is the comparison this had
 * before it moved here. The merge carries an existing item's mark along
 * unchanged, so comparing it could only ever agree, and adding it would be a
 * silent widening of when this store writes.
 */
function sameItems(left: readonly RepoMemoryItem[], right: readonly RepoMemoryItem[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.text === right[index]?.text && item.runId === right[index]?.runId,
    )
  );
}

/**
 * The admin half: what this store holds, for the memory screen and its MCP
 * tools.
 *
 * MAY THROW, unlike the two methods above, and the port says so: `list`, `read`
 * and `forget` have no failure shape to answer with, so a store that cannot
 * throw has to report a failure as an empty list, an absent document or an
 * erasure that found nothing. Every one of those is a sentence that tells
 * somebody their data is gone. The containment is
 * `services/memory/memory-documents.ts`, which wraps all three and turns a
 * throw into a refusal carrying the provider's own words.
 *
 * `complete` is NOT always true here. This store enumerates itself, but its
 * listing runs under a row cap, and past that cap a screen showing a short
 * table with nothing saying so is exactly the absence-as-proof this flag
 * exists to prevent.
 */
const builtinMemoryStore: MemoryStoreAdapter = {
  async list(options) {
    const { listConnectedMemoryDocuments } = await import("../../db/repositories/memory.js");
    // The cap belongs to the repository, so the answer does too: this store
    // passes the caller's limit through and reports back what the query found,
    // rather than keeping a second copy of the cap that could drift from it.
    return await listConnectedMemoryDocuments(
      options.ticketKey === undefined
        ? options.limit === undefined
          ? {}
          : { limit: options.limit }
        : options.limit === undefined
          ? { ticketKey: options.ticketKey }
          : { ticketKey: options.ticketKey, limit: options.limit },
    );
  },
  async read(ref: MemoryStoredDocumentRef) {
    const { getConnectedMemoryDocument } = await import("../../db/repositories/memory.js");
    const document = await getConnectedMemoryDocument(ref.subjectKey, ref.docPath);
    return document === null ? null : { ...document };
  },
  async forget(ref: MemoryStoredDocumentRef) {
    const { deleteConnectedMemoryDocument } = await import("../../db/repositories/memory.js");
    return deleteConnectedMemoryDocument(ref.subjectKey, ref.docPath);
  },
};

function failureDetail(error: unknown): string {
  // Bare message only. A driver error can echo the statement it failed on, and
  // with it the document, so this never widens into a dump.
  return error instanceof Error ? error.message : String(error);
}
