/**
 * Reading the memory ledger and the entry state back, for the run card,
 * `/memory` history, the Needs review inbox and MCP.
 *
 * Every text is cleaned again with the secret set of the day before it is
 * returned: a value that became a secret after it was recorded never shows in
 * the clear. FAILS CLOSED: when the set cannot be read, or a text cannot be
 * cleaned, the read answers `unavailable` and returns nothing. A database
 * failure is not caught here; the route that reads decides what it says.
 *
 * Workflow-scope safe: the repository is a deferred import.
 */
import { memoryTextHash } from "@integrations/sdk";
import type { MemoryOpenDispute, MemoryStateKind } from "../../db/memory-vocabulary.js";
import type {
  MemoryEntryStateValues,
  MemoryLedgerRepository,
  StoredMemoryEntryState,
} from "../../db/repositories/memory-entry-state.js";
import type { StoredMemoryEvent } from "../../db/repositories/memory-events.js";
import {
  KNOWN_SECRETS_UNREADABLE,
  knownSecretsReader,
  takeOutKnownSecrets,
  type KnownSecretsReader,
} from "../known-secrets.js";
import { cleanStrings } from "./clean.js";
import { defaultMemoryEntryState, type MemoryEntryOriginHint } from "./entry-state.js";
import type { MemoryEntryRef } from "./writer.js";

type MemoryLedgerRead<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: "unavailable"; readonly detail: string };

type MemoryLedgerPage = MemoryLedgerRead<{
  readonly events: StoredMemoryEvent[];
  /** The cursor for the next page; null on the last one. */
  readonly next: number | null;
}>;

/** An entry's state as the core reads it: stored, or the defaults. */
type MemoryEntryStateView =
  | ({ readonly stored: true } & StoredMemoryEntryState)
  | ({
      readonly stored: false;
      readonly entryKey: null;
      readonly subject: string;
      readonly kind: MemoryStateKind;
      readonly textHash: string;
    } & MemoryEntryStateValues);

export interface MemoryLedgerReaderDeps {
  readonly repository?: () => MemoryLedgerRepository | Promise<MemoryLedgerRepository>;
  readonly knownSecrets?: KnownSecretsReader;
}

interface MemoryHistoryQuery {
  readonly subject?: string;
  readonly entryKey?: string;
  /** Every row about this text, found by its normalised hash. */
  readonly text?: string;
  readonly textHash?: string;
  readonly before?: number;
  readonly limit?: number;
}

export interface MemoryLedgerReader {
  /** A run's memory events, oldest first. */
  runTimeline(runId: string, options?: { after?: number; limit?: number }): Promise<MemoryLedgerPage>;
  /** History newest first: of a subject, an entry, a text, or any mix. */
  history(query: MemoryHistoryQuery): Promise<MemoryLedgerPage>;
  /** Rows whose texts contain a fragment, newest first. */
  search(query: { contains: string; subject?: string; before?: number; limit?: number }): Promise<MemoryLedgerPage>;
  /** Proposals still waiting for this pull request to merge. */
  pendingProposals(prRef: string): Promise<MemoryLedgerRead<{ readonly events: StoredMemoryEvent[] }>>;
  /** One entry's state, or the defaults when it has none. `origin` picks the
   *  default trust of an entry without a row. */
  entryState(
    ref: MemoryEntryRef,
    origin?: MemoryEntryOriginHint,
  ): Promise<MemoryLedgerRead<{ readonly state: MemoryEntryStateView | null }>>;
  /** Every stored entry state of a subject. */
  entryStates(query: {
    subject: string;
    kind?: MemoryStateKind;
  }): Promise<MemoryLedgerRead<{ readonly states: StoredMemoryEntryState[] }>>;
}

async function connectedRepository(): Promise<MemoryLedgerRepository> {
  const { connectedMemoryLedgerRepository } = await import("../../db/repositories/memory-entry-state.js");
  return connectedMemoryLedgerRepository();
}

function cleanEvent(event: StoredMemoryEvent, clean: (text: string) => string): StoredMemoryEvent {
  const optional = (text: string | null) => (text === null ? null : clean(text));
  return {
    ...event,
    text: optional(event.text),
    previousText: optional(event.previousText),
    reason: optional(event.reason),
    detail: cleanStrings(event.detail, clean),
  };
}

/** A state's addresses stay as they are; its dispute reasons are cleaned. */
function cleanState<T extends { readonly openDisputes: readonly MemoryOpenDispute[] }>(
  state: T,
  clean: (text: string) => string,
): T {
  return {
    ...state,
    openDisputes: state.openDisputes.map((dispute) => ({
      ...dispute,
      reason: dispute.reason === null ? null : clean(dispute.reason),
    })),
  };
}

export function memoryLedgerReader(deps: MemoryLedgerReaderDeps = {}): MemoryLedgerReader {
  const repository = deps.repository ?? connectedRepository;
  const knownSecrets = deps.knownSecrets ?? knownSecretsReader();

  /** The value cleaned with the current set, or the refusal. */
  async function cleaned<T extends object>(
    value: T,
    apply: (value: T, clean: (text: string) => string) => T,
  ): Promise<MemoryLedgerRead<T>> {
    const taken = await takeOutKnownSecrets((clean) => apply(value, clean), knownSecrets());
    if (taken.ok) return { ok: true, ...taken.value };
    return {
      ok: false,
      code: "unavailable",
      detail:
        taken.why === "unreadable"
          ? `${KNOWN_SECRETS_UNREADABLE}, so the memory history was not read`
          : "the memory history could not be cleaned of this deployment's secrets, so it was not shown",
    };
  }

  const cleanPage = (page: { events: StoredMemoryEvent[]; next: number | null }) =>
    cleaned(page, (value, clean) => ({ ...value, events: value.events.map((event) => cleanEvent(event, clean)) }));

  async function textHashOf(ref: { text?: string; textHash?: string }): Promise<string | undefined> {
    return ref.text !== undefined ? memoryTextHash(ref.text) : ref.textHash;
  }

  return {
    async runTimeline(runId, options = {}) {
      return cleanPage(await (await repository()).runEvents(runId, options));
    },

    async history(query) {
      const textHash = await textHashOf(query);
      return cleanPage(
        await (await repository()).history({
          ...(query.subject === undefined ? {} : { subject: query.subject }),
          ...(query.entryKey === undefined ? {} : { entryKey: query.entryKey }),
          ...(textHash === undefined ? {} : { textHash }),
          ...(query.before === undefined ? {} : { before: query.before }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        }),
      );
    },

    async search(query) {
      return cleanPage(await (await repository()).search(query));
    },

    async pendingProposals(prRef) {
      const events = await (await repository()).pendingProposals(prRef);
      return cleaned({ events }, (value, clean) => ({
        events: value.events.map((event) => cleanEvent(event, clean)),
      }));
    },

    async entryState(ref, origin) {
      const store = await repository();
      if ("entryKey" in ref) {
        const row = await store.entryState({ entryKey: ref.entryKey });
        return cleaned({ state: row === null ? null : ({ stored: true, ...row } as MemoryEntryStateView) }, (value, clean) => ({
          state: value.state === null ? null : cleanState(value.state, clean),
        }));
      }
      const textHash = (await textHashOf(ref))!;
      const alias = { subject: ref.subject, kind: ref.kind, textHash };
      const row = await store.entryState({ alias });
      const state: MemoryEntryStateView =
        row === null
          ? { stored: false, entryKey: null, ...alias, ...defaultMemoryEntryState(origin) }
          : { stored: true, ...row };
      return cleaned({ state }, (value, clean) => ({ state: cleanState(value.state!, clean) }));
    },

    async entryStates(query) {
      const states = await (await repository()).entryStates(query);
      return cleaned({ states }, (value, clean) => ({
        states: value.states.map((state) => cleanState(state, clean)),
      }));
    },
  };
}
