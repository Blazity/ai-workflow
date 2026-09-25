/**
 * A memory provider for the characterization suites, standing where
 * `activeMemory()` answers (`engine/support/memory-runtime.ts`).
 *
 * It is the smallest honest store: documents keyed by subject and scope, a
 * recall that answers what is held (leaving out an `exclude`d text by exact
 * match), and an observe that appends what is new and forgets what a run
 * refuted, both by exact text. Every request is recorded in call order, so a
 * suite asserts what a step ASKED of memory rather than how some store happened
 * to reconcile it. A suite about the built-in store's own reconciling uses the
 * real store on pglite instead.
 */
import type {
  MemoryObserveRequest,
  MemoryRecall,
  MemoryRecallRequest,
  MemoryScope,
  MemoryWrite,
} from "@integrations/sdk";
import type { ActiveMemory } from "../engine/support/memory-runtime.js";

/** What one subject and scope holds: its entries, and optionally the exact
 *  rendering a recall hands back (a suite about byte budgets sets it). */
export interface FakeMemoryDocument {
  entries: string[];
  rendering?: string;
}

/** The address a document is filed under in this fake. */
export function fakeMemoryAddress(subjectKey: string, scope: MemoryScope): string {
  return `${subjectKey}|${scope.kind === "notebook" ? `notebook/${scope.name}` : scope.kind}`;
}

export interface FakeActiveMemory {
  memory: ActiveMemory;
  /** Every recall, in call order. */
  recalls: MemoryRecallRequest[];
  /** Every observe, in call order. */
  observations: MemoryObserveRequest[];
  /** The documents as they are now, by `fakeMemoryAddress`. */
  documents: Map<string, FakeMemoryDocument>;
}

export function fakeActiveMemory(
  seed: Record<string, FakeMemoryDocument> = {},
  options: {
    /** Answers a recall instead of the documents when it returns an answer. */
    recall?: (request: MemoryRecallRequest) => MemoryRecall | undefined;
    /** Answers an observe instead of the documents when it returns an answer. */
    observe?: (request: MemoryObserveRequest) => MemoryWrite | undefined;
  } = {},
): FakeActiveMemory {
  const documents = new Map<string, FakeMemoryDocument>(
    Object.entries(seed).map(([address, document]) => [
      address,
      { ...document, entries: [...document.entries] },
    ]),
  );
  const recalls: MemoryRecallRequest[] = [];
  const observations: MemoryObserveRequest[] = [];

  const memory: ActiveMemory = {
    id: "fake",
    name: "Fake memory",
    refusal: null,
    store: null,
    async recall(request) {
      recalls.push(structuredClone(request));
      const override = options.recall?.(request);
      if (override) return override;
      const document = documents.get(fakeMemoryAddress(request.subject.key, request.scope));
      if (!document) return { ok: true, held: false, entries: [], rendering: "" };
      const excluded = new Set(request.exclude ?? []);
      const entries = document.entries.filter((text) => !excluded.has(text));
      const rendering =
        document.rendering !== undefined && entries.length === document.entries.length
          ? document.rendering
          : entries.map((text) => `- ${text}`).join("\n");
      return {
        ok: true,
        held: true,
        entries: entries.map((text) => ({ text })),
        rendering: entries.length === 0 ? "" : rendering,
      };
    },
    async observe(request) {
      observations.push(structuredClone(request));
      const override = options.observe?.(request);
      if (override) return override;
      const address = fakeMemoryAddress(request.subject.key, request.scope);
      const document = documents.get(address) ?? { entries: [] };
      const { observation } = request;
      if (observation.kind === "document") {
        documents.set(address, { entries: [observation.text] });
        return { ok: true, stored: true, removed: 0, dropped: 0, remaining: 1 };
      }
      if (observation.onlyIfEmpty && document.entries.length > 0) {
        return { ok: true, stored: false, removed: 0, dropped: 0, remaining: document.entries.length };
      }
      const kept = document.entries.filter((text) => !observation.refuted.includes(text));
      const removed = document.entries.length - kept.length;
      const added = observation.learned.filter(
        (text, index, all) =>
          all.indexOf(text) === index && !kept.includes(text) && !observation.refuted.includes(text),
      );
      documents.set(address, { entries: [...kept, ...added] });
      return {
        ok: true,
        stored: added.length > 0 || removed > 0,
        removed,
        dropped: 0,
        remaining: kept.length + added.length,
      };
    },
  };
  return { memory, recalls, observations, documents };
}
