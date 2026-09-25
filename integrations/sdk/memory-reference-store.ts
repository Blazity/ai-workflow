/**
 * The memory store port (version 2) kept in memory: the reference every
 * conformance case is proven against, in each shape a real store takes.
 *
 * - `ids`: `stable` keeps an entry's id through an update and can hold two
 *   entries with the same normalised text (Mem0 does); `from_text` derives
 *   the id from the normalised text, so an update changes it, a second
 *   spelling of a held entry is `already_held`, and an update to a text
 *   another entry holds is refused (the built-in store does).
 * - `ranks`: with a query, orders by the share of the query's words an entry
 *   contains and leaves an entry sharing none unscored, after the rest.
 * - `versions`: `held` answers a version and `apply` honours `ifVersion`.
 * - `traits`: a consolidating shape does nothing on its own until
 *   `consolidateNow`, which stands for the engine's own pass (Mem0's
 *   Supersede): among entries of one subject and kind with the same
 *   normalised text, every one but the newest is marked `replacedBy` the
 *   newest, and a protected entry is left alone when the shape protects.
 * - `queues`: the engine queues every write that creates an entry until
 *   `settleNow`, as Mem0 does when it answers an add with an event and no
 *   memory id. An addition answers `pending`; an update replaces the entry
 *   (Mem0's legacy immutable entries), queueing the new text and deleting the
 *   old entry, and answers `pending`. Meant with `stable` ids.
 * - `unreachable`: every member answers `unavailable`.
 *
 * Test support: nothing in production imports it.
 */
import {
  memoryTextHash,
  normalizeMemoryText,
  type MemoryEntryOrigin,
  type MemoryHolding,
  type MemoryKind,
  type MemoryRecalledEntry,
  type MemoryStore,
  type MemoryStoreApplyOutcome,
  type MemoryStoreEntry,
  type MemoryStoreRefusal,
  type MemoryStoreTraits,
} from "./memory";

export interface ReferenceMemoryStoreOptions {
  readonly ids?: "stable" | "from_text";
  readonly ranks?: boolean;
  readonly versions?: boolean;
  readonly traits?: MemoryStoreTraits;
  readonly queues?: boolean;
  readonly unreachable?: boolean;
}

export interface ReferenceMemoryStore extends MemoryStore {
  /** The consolidating engine's own pass; nothing for a shape that does not consolidate. */
  consolidateNow(): void;
  /** The queueing engine processes its queue: every queued text is stored, oldest first; nothing for a shape that does not queue. */
  settleNow(): void;
}

interface Stored {
  id: string;
  text: string;
  origin: MemoryEntryOrigin;
  runId?: string;
  ticketKey?: string;
  updatedAt: string;
  replacedBy?: string;
  protect: boolean;
}

const KINDS: readonly MemoryKind[] = ["facts", "lessons"];

function refused(code: MemoryStoreRefusal["code"], detail: string): MemoryStoreRefusal {
  return { ok: false, code, detail };
}

function words(text: string): Set<string> {
  return new Set(
    normalizeMemoryText(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

export function referenceMemoryStore(options: ReferenceMemoryStoreOptions = {}): ReferenceMemoryStore {
  const traits: MemoryStoreTraits = options.traits ?? { consolidates: false };
  const shelves = new Map<string, Stored[]>();
  const queued: { subject: string; kind: MemoryKind; entry: Omit<Stored, "id" | "updatedAt"> }[] = [];
  const versions = new Map<string, number>();
  let serial = 0;
  let clock = Date.parse("2026-09-25T08:00:00.000Z");

  const shelfKey = (subject: string, kind: MemoryKind) => JSON.stringify([subject, kind]);
  const shelf = (subject: string, kind: MemoryKind): Stored[] => {
    const key = shelfKey(subject, kind);
    let found = shelves.get(key);
    if (!found) shelves.set(key, (found = []));
    return found;
  };
  const bump = (subject: string, kind: MemoryKind) => {
    const key = shelfKey(subject, kind);
    versions.set(key, (versions.get(key) ?? 0) + 1);
  };
  const version = (subject: string, kind: MemoryKind) => `v${versions.get(shelfKey(subject, kind)) ?? 0}`;
  const now = () => new Date((clock += 1000)).toISOString();
  const newId = (text: string) =>
    options.ids === "from_text" ? `n:${normalizeMemoryText(text)}` : `m${(serial += 1)}`;

  const offline = refused("unavailable", "The reference store is switched off, so nothing could be read or written.");
  const unreachable = options.unreachable === true ? { ...offline, reason: "unreachable" as const } : null;

  function badAddress(subjects: readonly string[], kinds: readonly unknown[]): MemoryStoreRefusal | null {
    if (subjects.some((subject) => typeof subject !== "string" || subject.length === 0)) {
      return refused("rejected", "An empty subject addresses no subject, so the reference store refuses it.");
    }
    if (kinds.some((kind) => !KINDS.includes(kind as MemoryKind))) {
      return refused("rejected", "The reference store holds facts and lessons only.");
    }
    return null;
  }

  function entryOf(subject: string, kind: MemoryKind, stored: Stored): MemoryStoreEntry {
    return {
      id: stored.id,
      subject,
      kind,
      text: stored.text,
      origin: stored.origin,
      ...(stored.runId === undefined ? {} : { runId: stored.runId }),
      ...(stored.ticketKey === undefined ? {} : { ticketKey: stored.ticketKey }),
      updatedAt: stored.updatedAt,
      ...(stored.replacedBy === undefined ? {} : { replacedBy: stored.replacedBy }),
    };
  }

  return {
    traits,

    async recall(request) {
      if (unreachable) return unreachable;
      const bad = badAddress(request.subjects, request.kinds);
      if (bad) return bad;
      const listed: MemoryStoreEntry[] = [];
      for (const subject of new Set(request.subjects)) {
        for (const kind of new Set(request.kinds)) {
          for (const stored of shelves.get(shelfKey(subject, kind)) ?? []) {
            listed.push(entryOf(subject, kind, stored));
          }
        }
      }
      const query = request.query?.trim() ?? "";
      if (options.ranks !== true || query.length === 0) return { ok: true, ranked: false, entries: listed };
      const asked = words(query);
      const scored: MemoryRecalledEntry[] = [];
      const unscored: MemoryRecalledEntry[] = [];
      for (const entry of listed) {
        const own = words(entry.text);
        const shared = [...asked].filter((word) => own.has(word)).length;
        if (shared === 0 || asked.size === 0) unscored.push(entry);
        else scored.push({ ...entry, score: shared / asked.size });
      }
      // A stable sort keeps stored order among entries that score the same.
      scored.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
      return { ok: true, ranked: true, entries: [...scored, ...unscored] };
    },

    async held(request) {
      if (unreachable) return unreachable;
      const bad = badAddress([request.subject], [request.kind]);
      if (bad) return bad;
      const entries = (shelves.get(shelfKey(request.subject, request.kind)) ?? []).map((stored) =>
        entryOf(request.subject, request.kind, stored),
      );
      return options.versions === true
        ? { ok: true, entries, version: version(request.subject, request.kind) }
        : { ok: true, entries };
    },

    async apply(request) {
      if (unreachable) return unreachable;
      const bad = badAddress([request.subject], [request.kind]);
      if (bad) return bad;
      if (request.ifVersion !== undefined) {
        if (options.versions !== true) {
          return refused("rejected", "The reference store keeps no versions, so it cannot apply only if one still holds.");
        }
        if (request.ifVersion !== version(request.subject, request.kind)) {
          return refused("contended", "What this subject holds changed since it was read, so nothing was applied.");
        }
      }
      const entries = shelf(request.subject, request.kind);
      const stamp = {
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        ...(request.ticketKey === undefined ? {} : { ticketKey: request.ticketKey }),
      };
      const outcomes: MemoryStoreApplyOutcome[] = [];
      let changed = false;

      request.remove.forEach((removal, index) => {
        const at = entries.findIndex((stored) => stored.id === removal.id);
        if (at === -1) {
          outcomes.push({ op: "remove", index, result: "missing", id: removal.id });
          return;
        }
        entries.splice(at, 1);
        changed = true;
        outcomes.push({ op: "remove", index, result: "removed", id: removal.id, reason: removal.reason });
      });

      request.update.forEach((update, index) => {
        const target = entries.find((stored) => stored.id === update.id);
        if (!target) {
          outcomes.push({ op: "update", index, result: "missing", id: update.id });
          return;
        }
        if (options.queues === true) {
          // A replacement: the new text first, then the old entry goes.
          queued.push({
            subject: request.subject,
            kind: request.kind,
            entry: { text: update.text, origin: target.origin, protect: update.protect === true, ...stamp },
          });
          entries.splice(entries.indexOf(target), 1);
          changed = true;
          outcomes.push({ op: "update", index, result: "pending", previousId: update.id });
          return;
        }
        const id = options.ids === "from_text" ? newId(update.text) : target.id;
        // Ids that follow the text: the new text may be another entry's.
        const other = entries.find((stored) => stored.id === id && stored !== target);
        if (other) {
          outcomes.push({
            op: "update",
            index,
            result: "failed",
            code: "rejected",
            detail: `The new text is already held under ${other.id}, so the reference store changed nothing.`,
            heldId: other.id,
          });
          return;
        }
        Object.assign(target, {
          id,
          text: update.text,
          updatedAt: now(),
          protect: update.protect === true,
          runId: undefined,
          ticketKey: undefined,
          replacedBy: undefined,
          ...stamp,
        });
        changed = true;
        outcomes.push({ op: "update", index, result: "updated", previousId: update.id, id });
      });

      request.add.forEach((addition, index) => {
        if (options.queues === true) {
          queued.push({
            subject: request.subject,
            kind: request.kind,
            entry: { text: addition.text, origin: addition.origin, protect: addition.protect === true, ...stamp },
          });
          outcomes.push({ op: "add", index, result: "pending" });
          return;
        }
        const id = newId(addition.text);
        if (entries.some((stored) => stored.id === id)) {
          outcomes.push({ op: "add", index, result: "already_held", id });
          return;
        }
        entries.push({
          id,
          text: addition.text,
          origin: addition.origin,
          updatedAt: now(),
          protect: addition.protect === true,
          ...stamp,
        });
        changed = true;
        outcomes.push({ op: "add", index, result: "added", id });
      });

      if (changed) bump(request.subject, request.kind);
      return { ok: true, outcomes };
    },

    async forget(request) {
      if (unreachable) return unreachable;
      const bad = badAddress([request.subject], request.kind === undefined ? [] : [request.kind]);
      if (bad) return bad;
      const removed: { id: string; kind: MemoryKind }[] = [];
      for (const kind of request.kind === undefined ? KINDS : [request.kind]) {
        const entries = shelves.get(shelfKey(request.subject, kind));
        if (!entries) continue;
        const keep: Stored[] = [];
        for (const stored of entries) {
          const matches = request.textHash === undefined || (await memoryTextHash(stored.text)) === request.textHash;
          if (matches) removed.push({ id: stored.id, kind });
          else keep.push(stored);
        }
        if (keep.length !== entries.length) {
          entries.splice(0, entries.length, ...keep);
          bump(request.subject, kind);
        }
      }
      return { ok: true, removed };
    },

    async list() {
      if (unreachable) return unreachable;
      const holdings: MemoryHolding[] = [];
      for (const [key, entries] of shelves) {
        if (entries.length === 0) continue;
        const [subject, kind] = JSON.parse(key) as [string, MemoryKind];
        const updatedAt = entries.map((stored) => stored.updatedAt).sort().at(-1);
        holdings.push(updatedAt === undefined ? { subject, kind, entries: entries.length } : { subject, kind, entries: entries.length, updatedAt });
      }
      return { ok: true, holdings, complete: true };
    },

    consolidateNow() {
      if (!traits.consolidates) return;
      for (const entries of shelves.values()) {
        const groups = new Map<string, Stored[]>();
        for (const stored of entries) {
          if (stored.protect && traits.protects) continue;
          const key = normalizeMemoryText(stored.text);
          groups.set(key, [...(groups.get(key) ?? []), stored]);
        }
        for (const group of groups.values()) {
          const newest = group.at(-1);
          if (!newest) continue;
          for (const older of group.slice(0, -1)) older.replacedBy = newest.id;
        }
      }
    },

    settleNow() {
      for (const { subject, kind, entry } of queued.splice(0)) {
        shelf(subject, kind).push({ ...entry, id: newId(entry.text), updatedAt: now() });
        bump(subject, kind);
      }
    },
  };
}
