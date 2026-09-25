/**
 * Writing the memory ledger and the entry state: best effort, redacted,
 * hashed.
 *
 * - BEST EFFORT. A write runs after the store call it records and never
 *   throws: a failure is one warning line with the run id, and the caller
 *   gets `{ ok: false }` to act on or ignore. Memory must never be lost
 *   because its record failed.
 * - REDACTED. Every text, and every string of an event's detail, is cleaned
 *   of this deployment's secrets by the rule in `memory/known-secrets.ts`
 *   before it is stored; the reader cleans again with the set of the day.
 *   When the set cannot be read, or a text cannot be cleaned, the row is
 *   still written (so every claim still ends in a row) with its texts
 *   withheld and `detail.textWithheld` saying why.
 * - HASHED. Each text's normalised hash (`memoryTextHash`) is computed from
 *   the text as stored; it is what a forget and a history look rows up by.
 *
 * An event's free text belongs in `text`, `previousText` and
 * `detail.items[].text`; `reason` and the rest of `detail` carry codes, ids
 * and counts.
 *
 * Workflow-scope safe: the repository and the logger are deferred imports, so
 * importing this module reaches no Node module.
 */
import type {
  MemoryEventDetail,
  MemoryEventDetailItem,
  MemoryOpenDispute,
  MemoryStateKind,
} from "../../db/memory-vocabulary.js";
import type {
  MemoryEntryStateChange,
  MemoryEntryStateValues,
  MemoryEntryStateWrite,
  MemoryLedgerRepository,
} from "../../db/repositories/memory-entry-state.js";
import type {
  ForgetMemoryTextResult,
  MemoryEventRecord,
} from "../../db/repositories/memory-events.js";
import { knownSecretsReader, takeOutKnownSecrets, type KnownSecretsReader } from "../known-secrets.js";
import { cleanStrings } from "./clean.js";
import { defaultMemoryEntryState, type MemoryEntryOriginHint } from "./entry-state.js";
import { memoryTextHash } from "./text-hash.js";

/** One event as a caller hands it over: texts in the clear, no hashes. */
interface MemoryEventInput
  extends Omit<MemoryEventRecord, "textHash" | "previousTextHash" | "detail"> {
  /** Names the entry the event is about when it carries no text of its own.
   *  Ignored when `text` is given: the hash is then the text's, as stored. */
  readonly textHash?: string | null;
  readonly detail?: MemoryEventDetail;
}

/** Why a row's texts were not stored. */
type MemoryTextWithheld = "unreadable" | "unscrubbable";

type MemoryLedgerRecordOutcome =
  | {
      readonly ok: true;
      readonly ids: number[];
      readonly duplicates: number;
      readonly withheld?: MemoryTextWithheld;
    }
  | { readonly ok: false };

type MemoryLedgerStateOutcome =
  | ({ readonly ok: true; readonly withheld?: MemoryTextWithheld } & MemoryEntryStateWrite)
  | { readonly ok: false };

type MemoryLedgerForgetOutcome =
  | ({ readonly ok: true } & ForgetMemoryTextResult)
  | { readonly ok: false };

/** Names an entry by its text or by the hash of its text. */
type MemoryEntryTextRef = { readonly text: string } | { readonly textHash: string };

export type MemoryEntryRef =
  | { readonly entryKey: string }
  | ({ readonly subject: string; readonly kind: MemoryStateKind } & MemoryEntryTextRef);

/** The state as a caller writes it: open disputes may carry their reason in the clear. */
type MemoryEntryStateInput = Partial<MemoryEntryStateValues>;

interface RecordEntryStateInput {
  readonly subject: string;
  readonly kind: MemoryStateKind;
  readonly text?: string;
  readonly textHash?: string;
  /** Picks the default trust of a new entry: `derived` for a derived one. */
  readonly origin?: MemoryEntryOriginHint;
  /** Over the defaults, for an entry that has no state yet. */
  readonly create?: MemoryEntryStateInput;
  /** For an entry that already has one. */
  readonly change?: MemoryEntryStateChange;
  readonly expectedVersion?: number;
  readonly events: readonly MemoryEventInput[];
}

interface ChangeEntryStateInput {
  readonly target: MemoryEntryRef;
  readonly change?: MemoryEntryStateChange;
  /** The entry's new text: its alias moves there, its key stays. */
  readonly moveTo?: MemoryEntryTextRef;
  readonly expectedVersion?: number;
  readonly events: readonly MemoryEventInput[];
}

interface ForgetInput {
  readonly subject: string;
  readonly kind?: MemoryStateKind;
  readonly text?: string;
  readonly textHash?: string;
  readonly actor: MemoryEventRecord["actor"];
  readonly runId: string | null;
  readonly store?: string | null;
  readonly source?: MemoryEventRecord["source"];
  readonly ticketKey?: string | null;
  readonly dedupeKey?: string | null;
  readonly detail?: MemoryEventDetail;
}

export type MemoryLedgerLog = (fields: Record<string, unknown>, message: string) => void;

export interface MemoryLedgerDeps {
  /** Defaults to the repository on the production database, imported and
   *  connected when first written. */
  readonly repository?: () => MemoryLedgerRepository | Promise<MemoryLedgerRepository>;
  /** Defaults to one read of the set, kept for as long as this writer is. */
  readonly knownSecrets?: KnownSecretsReader;
  /** Defaults to the worker's Pino logger, at warn. */
  readonly log?: MemoryLedgerLog;
}

export interface MemoryLedgerWriter {
  record(events: readonly MemoryEventInput[]): Promise<MemoryLedgerRecordOutcome>;
  recordEntryState(input: RecordEntryStateInput): Promise<MemoryLedgerStateOutcome>;
  changeEntryState(input: ChangeEntryStateInput): Promise<MemoryLedgerStateOutcome>;
  forget(input: ForgetInput): Promise<MemoryLedgerForgetOutcome>;
}

async function connectedRepository(): Promise<MemoryLedgerRepository> {
  const { connectedMemoryLedgerRepository } = await import("../../db/repositories/memory-entry-state.js");
  return connectedMemoryLedgerRepository();
}

const pinoWarn: MemoryLedgerLog = (fields, message) => {
  void import("../../infra/logger.js")
    .then(({ logger }) => logger.warn(fields, message))
    .catch(() => undefined);
};

/** The texts of one write, cleaned, or withheld with the reason. */
type Cleaned<T> = { readonly value: T; readonly withheld?: MemoryTextWithheld };

/** Everything a write stores that can hold a text, gathered so the secret set
 *  is read once and applied once. */
interface WriteTexts {
  readonly events: readonly MemoryEventInput[];
  readonly aliasText?: string;
  readonly moveToText?: string;
  readonly forgetText?: string;
  readonly disputes?: readonly MemoryOpenDispute[];
  readonly changeDisputes?: readonly MemoryOpenDispute[];
}

/**
 * An event's words cleaned: its texts, its reason and every string of its
 * detail. Its addresses (run, subject, store, ids, keys) are compared exactly
 * elsewhere and are never rewritten.
 */
function cleanEvent(event: MemoryEventInput, clean: (text: string) => string): MemoryEventInput {
  const optional = (text: string | null | undefined) => (typeof text === "string" ? clean(text) : text);
  return {
    ...event,
    text: optional(event.text),
    previousText: optional(event.previousText),
    reason: optional(event.reason),
    ...(event.detail === undefined ? {} : { detail: cleanStrings(event.detail, clean) }),
  };
}

function cleanTexts(texts: WriteTexts, clean: (text: string) => string): WriteTexts {
  const optional = (text: string | undefined) => (text === undefined ? undefined : clean(text));
  return {
    events: texts.events.map((event) => cleanEvent(event, clean)),
    aliasText: optional(texts.aliasText),
    moveToText: optional(texts.moveToText),
    forgetText: optional(texts.forgetText),
    disputes: texts.disputes?.map((dispute) => cleanDispute(dispute, clean)),
    changeDisputes: texts.changeDisputes?.map((dispute) => cleanDispute(dispute, clean)),
  };
}

/** A dispute's addresses stay as they are; its words are cleaned. */
function cleanDispute(dispute: MemoryOpenDispute, clean: (text: string) => string): MemoryOpenDispute {
  return { ...dispute, reason: dispute.reason === null ? null : clean(dispute.reason) };
}

/** Texts that could not be cleaned are not stored. Hashes are still taken
 *  from them, so a forget and a history still find the row. */
function withholdTexts(texts: WriteTexts, why: MemoryTextWithheld): WriteTexts {
  return {
    ...texts,
    events: texts.events.map((event) => ({
      ...event,
      detail: { ...event.detail, textWithheld: why },
    })),
    disputes: texts.disputes?.map((dispute) => ({ ...dispute, reason: null })),
    changeDisputes: texts.changeDisputes?.map((dispute) => ({ ...dispute, reason: null })),
  };
}

async function hashOf(text: string | null | undefined): Promise<string | null> {
  return typeof text === "string" ? memoryTextHash(text) : null;
}

/** One event, hashed, with its texts dropped when they were withheld. */
async function toRecord(event: MemoryEventInput, withheld: boolean): Promise<MemoryEventRecord> {
  const textHash = (await hashOf(event.text)) ?? event.textHash ?? null;
  const previousTextHash = await hashOf(event.previousText);
  const items = event.detail?.items;
  const hashedItems =
    items === undefined
      ? undefined
      : await Promise.all(
          items.map(async (item): Promise<MemoryEventDetailItem> => {
            if (typeof item.text !== "string") return item;
            return { ...item, text: withheld ? null : item.text, textHash: await memoryTextHash(item.text) };
          }),
        );
  return {
    ...event,
    text: withheld ? null : (event.text ?? null),
    textHash,
    previousText: withheld ? null : (event.previousText ?? null),
    previousTextHash,
    ...(event.detail === undefined
      ? {}
      : { detail: hashedItems === undefined ? event.detail : { ...event.detail, items: hashedItems } }),
  };
}

function runIdsOf(events: readonly MemoryEventInput[]): string[] {
  return [...new Set(events.flatMap((event) => (event.runId === null ? [] : [event.runId])))];
}

/** The writer every memory event and entry state change goes through. */
export function memoryLedgerWriter(deps: MemoryLedgerDeps = {}): MemoryLedgerWriter {
  const repository = deps.repository ?? connectedRepository;
  const knownSecrets = deps.knownSecrets ?? knownSecretsReader();
  const log = deps.log ?? pinoWarn;

  const say = (events: readonly MemoryEventInput[], fields: Record<string, unknown>, message: string) => {
    const runIds = runIdsOf(events);
    try {
      log(
        {
          runId: runIds[0] ?? null,
          ...(runIds.length > 1 ? { runIds } : {}),
          events: events.map((event) => event.event),
          ...fields,
        },
        message,
      );
    } catch {
      // A log that cannot be written is not a reason to throw out of a step.
    }
  };

  /** Clean, or withhold, every text of one write, reading the set once. */
  async function prepare(texts: WriteTexts): Promise<Cleaned<WriteTexts>> {
    const cleaned = await takeOutKnownSecrets((clean) => cleanTexts(texts, clean), knownSecrets());
    if (cleaned.ok) return { value: cleaned.value };
    say(texts.events, { withheld: cleaned.why }, "memory ledger texts withheld: they could not be cleaned of secrets");
    return { value: withholdTexts(texts, cleaned.why), withheld: cleaned.why };
  }

  async function records(texts: Cleaned<WriteTexts>): Promise<MemoryEventRecord[]> {
    return Promise.all(texts.value.events.map((event) => toRecord(event, texts.withheld !== undefined)));
  }

  /** Runs a write; any throw becomes `{ ok: false }` and one log line. */
  async function bestEffort<T>(
    events: readonly MemoryEventInput[],
    write: () => Promise<T>,
  ): Promise<T | { readonly ok: false }> {
    try {
      return await write();
    } catch (error) {
      say(events, { err: error instanceof Error ? error.message : String(error) }, "memory ledger write failed");
      return { ok: false };
    }
  }

  const withheldField = (withheld: MemoryTextWithheld | undefined) =>
    withheld === undefined ? {} : { withheld };

  return {
    record(events) {
      return bestEffort(events, async () => {
        if (events.length === 0) return { ok: true as const, ids: [], duplicates: 0 };
        const texts = await prepare({ events });
        const appended = await (await repository()).appendEvents(await records(texts));
        return { ok: true as const, ...appended, ...withheldField(texts.withheld) };
      });
    },

    recordEntryState(input) {
      return bestEffort(input.events, async () => {
        const create = { ...defaultMemoryEntryState(input.origin), ...input.create };
        const texts = await prepare({
          events: input.events,
          aliasText: input.text,
          disputes: create.openDisputes,
          changeDisputes: input.change?.openDisputes,
        });
        const textHash = await aliasHash(texts.value.aliasText, input.textHash);
        const written = await (await repository()).recordEntryState({
          alias: { subject: input.subject, kind: input.kind, textHash },
          create: { ...create, openDisputes: texts.value.disputes ?? [] },
          ...(input.change === undefined
            ? {}
            : {
                change: {
                  ...input.change,
                  ...(texts.value.changeDisputes === undefined
                    ? {}
                    : { openDisputes: texts.value.changeDisputes }),
                },
              }),
          ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
          events: await records(texts),
        });
        return { ok: true as const, ...written, ...withheldField(texts.withheld) };
      });
    },

    changeEntryState(input) {
      return bestEffort(input.events, async () => {
        const texts = await prepare({
          events: input.events,
          aliasText: "text" in input.target ? input.target.text : undefined,
          moveToText: input.moveTo !== undefined && "text" in input.moveTo ? input.moveTo.text : undefined,
          changeDisputes: input.change?.openDisputes,
        });
        const target =
          "entryKey" in input.target
            ? { entryKey: input.target.entryKey }
            : {
                alias: {
                  subject: input.target.subject,
                  kind: input.target.kind,
                  textHash: await aliasHash(
                    texts.value.aliasText,
                    "textHash" in input.target ? input.target.textHash : undefined,
                  ),
                },
              };
        const moveTo =
          input.moveTo === undefined
            ? undefined
            : await aliasHash(
                texts.value.moveToText,
                "textHash" in input.moveTo ? input.moveTo.textHash : undefined,
              );
        const written = await (await repository()).changeEntryState({
          target,
          ...(input.change === undefined
            ? {}
            : {
                change: {
                  ...input.change,
                  ...(texts.value.changeDisputes === undefined
                    ? {}
                    : { openDisputes: texts.value.changeDisputes }),
                },
              }),
          ...(moveTo === undefined ? {} : { moveTo }),
          ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
          events: await records(texts),
        });
        return { ok: true as const, ...written, ...withheldField(texts.withheld) };
      });
    },

    forget(input) {
      const event: MemoryEventInput = {
        event: "removed",
        runId: input.runId,
        actor: input.actor,
        reason: "forgotten",
        subject: input.subject,
        kind: input.kind ?? null,
        store: input.store ?? null,
        source: input.source ?? null,
        ticketKey: input.ticketKey ?? null,
        dedupeKey: input.dedupeKey ?? null,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      };
      return bestEffort([event], async () => {
        const texts = await prepare({ events: [event], forgetText: input.text });
        const textHash = await aliasHash(texts.value.forgetText, input.textHash);
        const [record] = await records(texts);
        const forgotten = await (await repository()).forgetText({
          textHash,
          subject: input.subject,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          events: [{ ...record!, textHash }],
        });
        return { ok: true as const, ...forgotten };
      });
    },
  };
}

/**
 * The hash an entry answers to: of its text as stored, or the one given. A
 * withheld text has been cleaned of nothing, and its hash is still taken, so
 * the entry is still found.
 */
async function aliasHash(text: string | undefined, textHash: string | undefined): Promise<string> {
  if (text !== undefined) return memoryTextHash(text);
  if (textHash !== undefined) return textHash;
  throw new Error("an entry is named by its text or by the hash of its text");
}
