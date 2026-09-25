/**
 * The memory store port, version 2, and the conformance check every memory
 * store passes. Two halves:
 *
 * - The in-memory reference store, in each shape a real store takes (ids that
 *   stay or that follow the text, ranked or not, versioned or not,
 *   consolidating or not), passes the check with no issue.
 * - Each deliberately broken store makes the check report the case that names
 *   its mistake. A row here is the proof that the case can go red, so a case
 *   that stops catching its mistake fails this file.
 *
 * The expected hashes come from `node:crypto`, not from the WebCrypto call the
 * SDK makes. The whole file also runs under the zod the production bundle
 * resolves (`pnpm run test:zod4`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  checkMemoryStoreConformance,
  memoryTextHash,
  normalizeMemoryText,
  type MemoryStore,
  type MemoryStoreApplyOutcome,
  type MemoryStoreApplyRequest,
  type MemoryStoreConformanceCase,
  type MemoryStoreConformanceHarness,
  type MemoryStoreConformanceIssue,
} from "./index";
import {
  referenceMemoryStore,
  type ReferenceMemoryStore,
  type ReferenceMemoryStoreOptions,
} from "./memory-reference-store";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A harness over the reference store in one shape, optionally broken by
 * `wrap`, and with `queueing` also over the same shape with its engine
 * queueing writes. Cases run one after another, so the store the last `open`
 * or `openQueueing` made is the one `consolidate` and `settle` act on.
 */
function harness(
  options: ReferenceMemoryStoreOptions,
  wrap: (store: ReferenceMemoryStore) => MemoryStore = (store) => store,
  queueing = false,
): MemoryStoreConformanceHarness {
  let current: ReferenceMemoryStore | undefined;
  const consolidating = options.traits?.consolidates === true;
  return {
    open: () => {
      current = referenceMemoryStore(options);
      return wrap(current);
    },
    openUnreachable: () => wrap(referenceMemoryStore({ ...options, unreachable: true })),
    ...(consolidating
      ? {
          consolidate: async () => {
            current?.consolidateNow();
          },
        }
      : {}),
    ...(queueing
      ? {
          openQueueing: () => {
            current = referenceMemoryStore({ ...options, queues: true });
            return wrap(current);
          },
          settle: async () => {
            current?.settleNow();
          },
        }
      : {}),
  };
}

/**
 * A copy of `value` with `change` written over it, which may add a field the
 * type does not have: that is how a broken store is made to carry one.
 */
function amended<T extends object>(value: T, change: Record<string, unknown>): T {
  return Object.assign({}, value, change);
}

/** The store with some members replaced; everything else is the store's own. */
function breaking(store: MemoryStore, members: Partial<MemoryStore>): MemoryStore {
  return {
    traits: members.traits ?? store.traits,
    recall: members.recall ?? ((request) => store.recall(request)),
    held: members.held ?? ((request) => store.held(request)),
    apply: members.apply ?? ((request) => store.apply(request)),
    forget: members.forget ?? ((request) => store.forget(request)),
    list: members.list ?? (() => store.list()),
  };
}

function describeIssues(issues: readonly MemoryStoreConformanceIssue[]): string {
  return issues.map((issue) => `  ${issue.case}: ${issue.message}`).join("\n") || "  (none)";
}

/** Each shape a real store takes. Every one passes with no issue. */
const SHAPES: readonly {
  readonly name: string;
  readonly options: ReferenceMemoryStoreOptions;
  readonly queueing?: boolean;
}[] = [
  { name: "stable ids, stored order, no versions (a plain store)", options: {} },
  {
    name: "ids from the text, versions (the built-in store's shape)",
    options: { ids: "from_text", versions: true },
  },
  {
    name: "ranks, consolidates, protects and queues (Mem0's shape with immutable entries)",
    options: { ranks: true, traits: { consolidates: true, protects: true } },
    queueing: true,
  },
  {
    name: "consolidates and cannot protect",
    options: { ranks: true, traits: { consolidates: true, protects: false } },
  },
];

for (const shape of SHAPES) {
  test(`the reference store passes: ${shape.name}`, async () => {
    const issues = await checkMemoryStoreConformance(harness(shape.options, undefined, shape.queueing));
    assert.deepEqual(issues, [], `conformance reported:\n${describeIssues(issues)}`);
  });
}

interface Mistake {
  readonly mistake: string;
  readonly catches: MemoryStoreConformanceCase;
  readonly options?: ReferenceMemoryStoreOptions;
  /** The harness also offers the shape with its engine queueing writes. */
  readonly queueing?: boolean;
  readonly wrap: (store: ReferenceMemoryStore) => MemoryStore;
}

/** The store applying each list of a request as its own apply, in `order`. */
function applyingInOrder(store: MemoryStore, order: readonly ("add" | "update" | "remove")[]): MemoryStore {
  return breaking(store, {
    apply: async (request) => {
      const outcomes: MemoryStoreApplyOutcome[] = [];
      for (const list of order) {
        const answer = await store.apply({ ...request, add: [], update: [], remove: [], [list]: request[list] });
        if (!answer.ok) return answer;
        outcomes.push(...answer.outcomes);
      }
      return { ok: true, outcomes };
    },
  });
}

/** The outcomes of an apply the store answered, each passed through `change`. */
function rewritingOutcomes(store: MemoryStore, change: (outcome: MemoryStoreApplyOutcome, request: MemoryStoreApplyRequest) => MemoryStoreApplyOutcome): MemoryStore {
  return breaking(store, {
    apply: async (request) => {
      const answer = await store.apply(request);
      return answer.ok ? { ...answer, outcomes: answer.outcomes.map((outcome) => change(outcome, request)) } : answer;
    },
  });
}

/** Each way an adapter gets the port wrong, and the case that must say so. */
const MISTAKES: readonly Mistake[] = [
  {
    mistake: "recall keeps only what the query matches",
    catches: "recall_complete",
    options: { ranks: true },
    wrap: (store) =>
      breaking(store, {
        recall: async (request) => {
          const answer = await store.recall(request);
          if (!answer.ok || !answer.ranked) return answer;
          return { ...answer, entries: answer.entries.filter((entry) => entry.score !== undefined) };
        },
      }),
  },
  {
    mistake: "recall stops at the item cap",
    catches: "recall_complete",
    wrap: (store) =>
      breaking(store, {
        recall: async (request) => {
          const answer = await store.recall(request);
          return answer.ok ? { ...answer, entries: answer.entries.slice(0, 40) } : answer;
        },
      }),
  },
  {
    mistake: "recall answers one search's top 100",
    catches: "recall_complete",
    options: { ranks: true },
    wrap: (store) =>
      breaking(store, {
        recall: async (request) => {
          const answer = await store.recall(request);
          return answer.ok ? { ...answer, entries: answer.entries.slice(0, 100) } : answer;
        },
      }),
  },
  {
    mistake: "an unranked recall carries the engine's scores",
    catches: "recall_ranking",
    wrap: (store) =>
      breaking(store, {
        recall: async (request) => {
          const answer = await store.recall(request);
          if (!answer.ok || answer.ranked) return answer;
          return { ...answer, entries: answer.entries.map((entry) => amended(entry, { score: 0.5 })) };
        },
      }),
  },
  {
    mistake: "a ranked recall puts the least relevant first",
    catches: "recall_ranking",
    options: { ranks: true },
    wrap: (store) =>
      breaking(store, {
        recall: async (request) => {
          const answer = await store.recall(request);
          if (!answer.ok || !answer.ranked) return answer;
          const scored = answer.entries.filter((entry) => entry.score !== undefined).reverse();
          const unscored = answer.entries.filter((entry) => entry.score === undefined);
          return { ...answer, entries: [...scored, ...unscored] };
        },
      }),
  },
  {
    mistake: "a recall calls itself ranked without a query",
    catches: "recall_ranking",
    wrap: (store) =>
      breaking(store, {
        recall: async (request) => {
          const answer = await store.recall(request);
          return answer.ok ? { ...answer, ranked: true } : answer;
        },
      }),
  },
  {
    mistake: "an unranked recall lists newest first while held lists oldest first",
    catches: "recall_stored_order",
    wrap: (store) =>
      breaking(store, {
        recall: async (request) => {
          const answer = await store.recall(request);
          return answer.ok && !answer.ranked ? { ...answer, entries: [...answer.entries].reverse() } : answer;
        },
      }),
  },
  {
    mistake: "held stops at the item cap",
    catches: "held_complete",
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          return answer.ok ? { ...answer, entries: answer.entries.slice(0, 40) } : answer;
        },
      }),
  },
  {
    mistake: "held reads one list page of 200",
    catches: "held_complete",
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          return answer.ok ? { ...answer, entries: answer.entries.slice(0, 200) } : answer;
        },
      }),
  },
  {
    mistake: "held lists newest first",
    catches: "held_order",
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          return answer.ok ? { ...answer, entries: [...answer.entries].reverse() } : answer;
        },
      }),
  },
  {
    mistake: "apply ignores a version that moved",
    catches: "held_version",
    options: { versions: true },
    wrap: (store) =>
      breaking(store, {
        apply: ({ ifVersion: _ignored, ...request }) => store.apply(request),
      }),
  },
  {
    mistake: "the version stays the same after a write",
    catches: "held_version",
    options: { versions: true },
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          return answer.ok ? { ...answer, version: "always-the-same" } : answer;
        },
        apply: ({ ifVersion, ...request }) =>
          store.apply(ifVersion === "always-the-same" ? request : { ...request, ifVersion }),
      }),
  },
  {
    mistake: "a store without versions ignores ifVersion",
    catches: "held_version",
    wrap: (store) =>
      breaking(store, {
        apply: ({ ifVersion: _ignored, ...request }) => store.apply(request),
      }),
  },
  {
    mistake: "apply leaves out the outcome of its last addition",
    catches: "apply_add",
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const answer = await store.apply(request);
          if (!answer.ok) return answer;
          const last = request.add.length - 1;
          return {
            ...answer,
            outcomes: answer.outcomes.filter((outcome) => !(outcome.op === "add" && outcome.index === last)),
          };
        },
      }),
  },
  {
    mistake: "an addition's outcome names an id nothing holds",
    catches: "apply_add",
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const answer = await store.apply(request);
          if (!answer.ok) return answer;
          return {
            ...answer,
            outcomes: answer.outcomes.map((outcome) =>
              outcome.op === "add" && outcome.result === "added" ? amended(outcome, { id: `event-${outcome.id}` }) : outcome,
            ),
          };
        },
      }),
  },
  {
    mistake: "apply does not stamp the run and the ticket",
    catches: "apply_add",
    wrap: (store) =>
      breaking(store, {
        apply: ({ runId: _run, ticketKey: _ticket, ...request }) => store.apply(request),
      }),
  },
  {
    mistake: "an update answers the old id although the store changed it",
    catches: "apply_update",
    options: { ids: "from_text" },
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const answer = await store.apply(request);
          if (!answer.ok) return answer;
          return {
            ...answer,
            outcomes: answer.outcomes.map((outcome) =>
              outcome.op === "update" && outcome.result === "updated" ? amended(outcome, { id: outcome.previousId }) : outcome,
            ),
          };
        },
      }),
  },
  {
    mistake: "an update is a removal and a fresh learned addition, losing the origin",
    catches: "apply_update",
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const answer = await store.apply({
            ...request,
            update: [],
            remove: [...request.remove, ...request.update.map((update) => ({ id: update.id, reason: "reverted" as const }))],
            add: [...request.add, ...request.update.map((update) => ({ text: update.text, origin: "learned" as const }))],
          });
          if (!answer.ok) return answer;
          const outcomes = answer.outcomes.filter(
            (outcome) =>
              !(outcome.op === "remove" && outcome.index >= request.remove.length) &&
              !(outcome.op === "add" && outcome.index >= request.add.length),
          );
          request.update.forEach((update, index) => {
            const added = answer.outcomes.find(
              (outcome) => outcome.op === "add" && outcome.index === request.add.length + index,
            );
            if (added && added.result === "added") {
              outcomes.push({ op: "update", index, result: "updated", previousId: update.id, id: added.id });
            }
          });
          return { ...answer, outcomes };
        },
      }),
  },
  {
    mistake: "an update of an id nobody holds fails instead of answering missing",
    catches: "apply_update",
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const answer = await store.apply(request);
          if (!answer.ok) return answer;
          return {
            ...answer,
            outcomes: answer.outcomes.map((outcome) =>
              outcome.op === "update" && outcome.result === "missing"
                ? { op: "update", index: outcome.index, result: "failed", code: "rejected", detail: "Unknown id." }
                : outcome,
            ),
          };
        },
      }),
  },
  {
    mistake: "a text-keyed store folds an updated entry into the one already holding its new text",
    catches: "apply_update",
    options: { ids: "from_text" },
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const answer = await store.apply(request);
          if (!answer.ok) return answer;
          const outcomes: MemoryStoreApplyOutcome[] = [];
          for (const outcome of answer.outcomes) {
            const update = outcome.op === "update" ? request.update[outcome.index] : undefined;
            if (outcome.result !== "failed" || outcome.heldId === undefined || !update) {
              outcomes.push(outcome);
              continue;
            }
            // The entry being updated goes, and the one holding the text takes the new spelling.
            await store.apply({
              subject: request.subject,
              kind: request.kind,
              add: [],
              update: [{ id: outcome.heldId, text: update.text }],
              remove: [{ id: update.id, reason: "reverted" }],
            });
            outcomes.push({ op: "update", index: outcome.index, result: "updated", previousId: update.id, id: outcome.heldId });
          }
          return { ...answer, outcomes };
        },
      }),
  },
  {
    mistake: "a failed item pairs a spent quota (413) with rejected",
    catches: "apply_update",
    options: { ids: "from_text" },
    wrap: (store) =>
      rewritingOutcomes(store, (outcome) => (outcome.result === "failed" ? { ...outcome, reason: "quota", status: 413 } : outcome)),
  },
  {
    mistake: "an add the engine queued is answered added with the engine's event id",
    catches: "apply_pending",
    queueing: true,
    wrap: (store) =>
      rewritingOutcomes(store, (outcome) =>
        outcome.op === "add" && outcome.result === "pending"
          ? { op: "add", index: outcome.index, result: "added", id: `event-${outcome.index}` }
          : outcome,
      ),
  },
  {
    mistake: "an update whose new text the engine queued is answered updated with an invented id",
    catches: "apply_pending",
    queueing: true,
    wrap: (store) =>
      rewritingOutcomes(store, (outcome) =>
        outcome.op === "update" && outcome.result === "pending"
          ? { op: "update", index: outcome.index, result: "updated", previousId: outcome.previousId, id: `event-${outcome.previousId}` }
          : outcome,
      ),
  },
  {
    mistake: "a text-keyed store applies additions, then updates, then removals, as the request lists them",
    catches: "apply_order",
    options: { ids: "from_text" },
    wrap: (store) => applyingInOrder(store, ["add", "update", "remove"]),
  },
  {
    mistake: "a text-keyed store applies updates before removals",
    catches: "apply_order",
    options: { ids: "from_text" },
    wrap: (store) => applyingInOrder(store, ["update", "remove", "add"]),
  },
  {
    mistake: "a text-keyed store applies additions before updates",
    catches: "apply_order",
    options: { ids: "from_text" },
    wrap: (store) => applyingInOrder(store, ["remove", "add", "update"]),
  },
  {
    mistake: "apply reads what the subject holds, waits, and writes it back whole",
    catches: "apply_concurrent",
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const address = { subject: request.subject, kind: request.kind };
          const read = await store.held(address);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const answer = await store.apply(request);
          const now = await store.held(address);
          if (!read.ok || !answer.ok || !now.ok) return answer;
          // What is written back is what was read plus this apply's own
          // changes, so whatever another apply added in between is gone.
          const kept = new Set([
            ...read.entries.map((entry) => entry.id),
            ...answer.outcomes.flatMap((outcome) => (outcome.result === "added" || outcome.result === "updated" ? [outcome.id] : [])),
          ]);
          const lost = now.entries.filter((entry) => !kept.has(entry.id));
          if (lost.length > 0) {
            await store.apply({ ...address, add: [], update: [], remove: lost.map((entry) => ({ id: entry.id, reason: "cap" as const })) });
          }
          return answer;
        },
      }),
  },
  {
    mistake: "apply refuses the removal reasons retired and reverted",
    catches: "apply_remove",
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const known = request.remove
            .map((removal, index) => ({ removal, index }))
            .filter(({ removal }) => removal.reason !== "retired" && removal.reason !== "reverted");
          const answer = await store.apply({ ...request, remove: known.map(({ removal }) => removal) });
          if (!answer.ok) return answer;
          const outcomes = answer.outcomes.map((outcome) =>
            outcome.op === "remove" ? { ...outcome, index: known[outcome.index]?.index ?? -1 } : outcome,
          );
          request.remove.forEach((_removal, index) => {
            if (known.some((kept) => kept.index === index)) return;
            outcomes.push({ op: "remove", index, result: "failed", code: "rejected", detail: "Unknown reason." });
          });
          return { ...answer, outcomes };
        },
      }),
  },
  {
    mistake: "a removal's outcome does not repeat the reason",
    catches: "apply_remove",
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const answer = await store.apply(request);
          if (!answer.ok) return answer;
          return {
            ...answer,
            outcomes: answer.outcomes.map((outcome) =>
              outcome.op === "remove" && outcome.result === "removed" ? amended(outcome, { reason: "forgotten" }) : outcome,
            ),
          };
        },
      }),
  },
  {
    mistake: "forget removes only the first entry with the text",
    catches: "forget_by_text_hash",
    wrap: (store) =>
      breaking(store, {
        forget: async (request) => {
          if (request.textHash === undefined) return store.forget(request);
          const removed: { id: string; kind: "facts" | "lessons" }[] = [];
          for (const kind of request.kind === undefined ? (["facts", "lessons"] as const) : [request.kind]) {
            const answer = await store.held({ subject: request.subject, kind });
            if (!answer.ok) return answer;
            for (const entry of answer.entries) {
              if ((await memoryTextHash(entry.text)) !== request.textHash) continue;
              await store.apply({ subject: request.subject, kind, add: [], update: [], remove: [{ id: entry.id, reason: "forgotten" }] });
              removed.push({ id: entry.id, kind });
              break;
            }
          }
          return { ok: true, removed };
        },
      }),
  },
  {
    mistake: "forget matches the stored text exactly instead of by its normalised form",
    catches: "forget_by_text_hash",
    wrap: (store) =>
      breaking(store, {
        forget: async (request) => {
          if (request.textHash === undefined) return store.forget(request);
          const removed: { id: string; kind: "facts" | "lessons" }[] = [];
          for (const kind of request.kind === undefined ? (["facts", "lessons"] as const) : [request.kind]) {
            const answer = await store.held({ subject: request.subject, kind });
            if (!answer.ok) return answer;
            const matching = answer.entries.filter((entry) => sha256Hex(entry.text) === request.textHash);
            await store.apply({
              subject: request.subject,
              kind,
              add: [],
              update: [],
              remove: matching.map((entry) => ({ id: entry.id, reason: "forgotten" as const })),
            });
            removed.push(...matching.map((entry) => ({ id: entry.id, kind })));
          }
          return { ok: true, removed };
        },
      }),
  },
  {
    mistake: "forget by text ignores the kind it was given",
    catches: "forget_by_text_hash",
    wrap: (store) => breaking(store, { forget: ({ kind: _kind, ...request }) => store.forget(request) }),
  },
  {
    mistake: "forget without a kind erases only facts",
    catches: "forget_document",
    wrap: (store) => breaking(store, { forget: (request) => store.forget({ ...request, kind: request.kind ?? "facts" }) }),
  },
  {
    mistake: "forget does not say what it removed",
    catches: "forget_document",
    wrap: (store) =>
      breaking(store, {
        forget: async (request) => {
          const answer = await store.forget(request);
          return answer.ok ? { ...answer, removed: [] } : answer;
        },
      }),
  },
  {
    mistake: "list leaves out lessons",
    catches: "list_holdings",
    wrap: (store) =>
      breaking(store, {
        list: async () => {
          const answer = await store.list();
          return answer.ok ? { ...answer, holdings: answer.holdings.filter((holding) => holding.kind !== "lessons") } : answer;
        },
      }),
  },
  {
    mistake: "list keeps a subject and kind that holds nothing any more",
    catches: "list_holdings",
    wrap: (store) =>
      breaking(store, {
        list: async () => {
          const answer = await store.list();
          if (!answer.ok || answer.holdings.length === 0) return answer;
          const kept = answer.holdings.some((holding) => holding.subject === "repo:conformance:acme/api" && holding.kind === "lessons");
          return kept
            ? answer
            : { ...answer, holdings: [...answer.holdings, { subject: "repo:conformance:acme/api", kind: "lessons", entries: 0 }] };
        },
      }),
  },
  {
    mistake: "the store lower-cases subjects",
    catches: "subjects_exact",
    wrap: (store) =>
      breaking(store, {
        recall: (request) => store.recall({ ...request, subjects: request.subjects.map((subject) => subject.toLowerCase()) }),
        held: (request) => store.held({ ...request, subject: request.subject.toLowerCase() }),
        apply: (request) => store.apply({ ...request, subject: request.subject.toLowerCase() }),
        forget: (request) => store.forget({ ...request, subject: request.subject.toLowerCase() }),
      }),
  },
  {
    mistake: "a subject holding * erases every subject it matches",
    catches: "subjects_exact",
    wrap: (store) =>
      breaking(store, {
        forget: async (request) => {
          if (!request.subject.includes("*")) return store.forget(request);
          const prefix = request.subject.slice(0, request.subject.indexOf("*"));
          const listing = await store.list();
          if (!listing.ok) return listing;
          const removed: { id: string; kind: "facts" | "lessons" }[] = [];
          for (const holding of listing.holdings.filter((candidate) => candidate.subject.startsWith(prefix))) {
            const answer = await store.forget({ subject: holding.subject, kind: holding.kind });
            if (answer.ok) removed.push(...answer.removed);
          }
          return { ok: true, removed };
        },
      }),
  },
  {
    mistake: "held entries carry the engine's trust and status",
    catches: "entry_fields",
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          if (!answer.ok) return answer;
          return { ...answer, entries: answer.entries.map((entry) => amended(entry, { trust: "learned", status: "active" })) };
        },
      }),
  },
  {
    mistake: "recalled entries carry a routing area",
    catches: "entry_fields",
    wrap: (store) =>
      breaking(store, {
        recall: async (request) => {
          const answer = await store.recall(request);
          if (!answer.ok) return answer;
          return { ...answer, entries: answer.entries.map((entry) => amended(entry, { area: "apps/api" })) };
        },
      }),
  },
  {
    mistake: "a refusal is thrown instead of answered",
    catches: "refusals_typed",
    wrap: (store) => {
      const raise = <T extends { ok: boolean }>(answer: T): T => {
        if (!answer.ok) throw new Error("memory store failed");
        return answer;
      };
      return breaking(store, {
        recall: async (request) => raise(await store.recall(request)),
        held: async (request) => raise(await store.held(request)),
        apply: async (request) => raise(await store.apply(request)),
        forget: async (request) => raise(await store.forget(request)),
        list: async () => raise(await store.list()),
      });
    },
  },
  {
    mistake: "a refusal carries a code of the store's own",
    catches: "refusals_typed",
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          return answer.ok ? answer : ({ ...answer, code: "error" } as unknown as typeof answer);
        },
      }),
  },
  {
    mistake: "a rate limit (429) is refused as rejected with its reason",
    catches: "refusals_typed",
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          return answer.ok || answer.code !== "rejected" ? answer : { ...answer, reason: "rate_limited", status: 429 };
        },
      }),
  },
  {
    mistake: "a refusal says nothing in its detail",
    catches: "refusals_typed",
    wrap: (store) =>
      breaking(store, {
        list: async () => {
          const answer = await store.list();
          return answer.ok ? answer : { ...answer, detail: "" };
        },
      }),
  },
  {
    mistake: "an empty subject is read as nothing held instead of refused",
    catches: "refusals_typed",
    wrap: (store) =>
      breaking(store, {
        held: (request) => (request.subject === "" ? Promise.resolve({ ok: true, entries: [] }) : store.held(request)),
      }),
  },
  {
    mistake: "a notebook is accepted as a kind",
    catches: "refusals_typed",
    wrap: (store) =>
      breaking(store, {
        apply: (request) =>
          (request.kind as string) === "notebook" ? Promise.resolve({ ok: true, outcomes: [] }) : store.apply(request),
      }),
  },
  {
    mistake: "the store folds a near-duplicate into the entry it resembles and declares it never consolidates",
    catches: "consolidation_declared",
    wrap: (store) =>
      breaking(store, {
        apply: async (request) => {
          const current = await store.held({ subject: request.subject, kind: request.kind });
          if (!current.ok || request.add.length !== 1) return store.apply(request);
          const [addition] = request.add;
          const start = (text: string) => normalizeMemoryText(text).split(" ").slice(0, 4).join(" ");
          const alike = current.entries.find((entry) => addition && start(entry.text) === start(addition.text));
          if (!alike || !addition) return store.apply(request);
          const answer = await store.apply({ ...request, add: [], update: [{ id: alike.id, text: addition.text }] });
          if (!answer.ok) return answer;
          return { ok: true, outcomes: [{ op: "add", index: 0, result: "added", id: alike.id }] };
        },
      }),
  },
  {
    mistake: "a store the harness can make consolidate declares it never does",
    catches: "consolidation_declared",
    options: { traits: { consolidates: true, protects: true } },
    wrap: (store) => breaking(store, { traits: { consolidates: false } }),
  },
  {
    mistake: "replacedBy names an entry the store does not hold",
    catches: "consolidation_declared",
    options: { traits: { consolidates: true, protects: true } },
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          if (!answer.ok) return answer;
          return {
            ...answer,
            entries: answer.entries.map((entry) =>
              entry.replacedBy === undefined ? entry : amended(entry, { replacedBy: `merged-${entry.replacedBy}` }),
            ),
          };
        },
      }),
  },
  {
    mistake: "a store that says it protects consolidates protected entries anyway",
    catches: "protect",
    options: { traits: { consolidates: true, protects: false } },
    wrap: (store) => breaking(store, { traits: { consolidates: true, protects: true } }),
  },
  {
    mistake: "a store that cannot protect refuses a protected addition",
    catches: "protect",
    options: { traits: { consolidates: true, protects: false } },
    wrap: (store) =>
      breaking(store, {
        apply: (request) =>
          request.add.some((addition) => addition.protect === true)
            ? Promise.resolve({ ok: false, code: "rejected", detail: "This engine cannot keep an entry out of its consolidation." })
            : store.apply(request),
      }),
  },
  {
    mistake: "an entry a person wrote reads back as learned",
    catches: "origins_round_trip",
    wrap: (store) =>
      breaking(store, {
        held: async (request) => {
          const answer = await store.held(request);
          if (!answer.ok) return answer;
          return {
            ...answer,
            entries: answer.entries.map((entry) =>
              entry.origin === "human" ? amended(entry, { origin: "learned" }) : entry,
            ),
          };
        },
      }),
  },
];

for (const row of MISTAKES) {
  test(`conformance catches: ${row.mistake} (${row.catches})`, async (t) => {
    const issues = await checkMemoryStoreConformance(harness(row.options ?? {}, row.wrap, row.queueing));
    const caught = issues.find((issue) => issue.case === row.catches);
    assert.ok(caught, `expected ${row.catches} among the issues, which were:\n${describeIssues(issues)}`);
    t.diagnostic(caught.message);
  });
}

test("two spellings of one entry normalise to the same text", () => {
  assert.equal(normalizeMemoryText("  - * Use pnpm   for installs.  "), "use pnpm for installs");
  assert.equal(normalizeMemoryText("USE PNPM\tFOR\nINSTALLS"), "use pnpm for installs");
  // One final full stop goes, and nothing else about the punctuation.
  assert.equal(normalizeMemoryText("Run `pnpm -w build`..."), "run `pnpm -w build`..");
  assert.equal(normalizeMemoryText("Zażółć gęślą jaźń."), "zażółć gęślą jaźń");
  assert.notEqual(normalizeMemoryText("Use pnpm."), normalizeMemoryText("Use npm."));
});

test("the text hash is SHA-256 of the normalised text, as lowercase hex", async () => {
  assert.equal(await memoryTextHash("  - Use pnpm for installs."), sha256Hex("use pnpm for installs"));
  assert.equal(await memoryTextHash("Zażółć gęślą jaźń."), sha256Hex("zażółć gęślą jaźń"));
  assert.equal(await memoryTextHash("USE PNPM FOR INSTALLS"), await memoryTextHash("use pnpm for installs."));
  assert.notEqual(await memoryTextHash("Use pnpm."), await memoryTextHash("Use npm."));
});

test("a NUL character and a decomposed accent do not make a second entry", async () => {
  // A NUL never survives into stored text (Postgres text refuses it), so a
  // text that carried one is the same entry as the text without it.
  assert.equal(await memoryTextHash("use pnpm\u0000"), sha256Hex("use pnpm"));
  assert.equal(await memoryTextHash("- use  PNPM"), sha256Hex("use pnpm"));
  // "café" typed with a combining accent (NFD) and precomposed (NFC).
  assert.equal(await memoryTextHash("Café closes at 5."), sha256Hex("café closes at 5"));
  assert.equal(normalizeMemoryText("Café"), "café");
});
