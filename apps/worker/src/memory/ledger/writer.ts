/**
 * Writing the memory ledger and the entry state: best effort, checked,
 * redacted, hashed, capped.
 *
 * - BEST EFFORT. A write runs after the store call it records and never
 *   throws: a failure is one warning line with the run id, and the caller
 *   gets `{ ok: false }` to act on or ignore. Memory must never be lost
 *   because its record failed. The line names the error's class and the
 *   database's code and constraint, never its message: drizzle's message
 *   carries the statement's parameters, which are the texts.
 * - CHECKED. Every word (event, actor, source, kind, topic, trust, status,
 *   area status) is one of `db/memory-vocabulary.ts`; a write with any other
 *   is refused here, with one log line, because the tables take any text.
 * - REDACTED. Every text, reason, dispute reason and every string and key of
 *   an event's detail is, in this order: stripped of NUL, made well formed (a
 *   lone surrogate would fail the whole statement), cleaned of this
 *   deployment's secrets by the rule in `memory/known-secrets.ts`, hashed, and
 *   only then cut to size, so no fragment of a secret survives at a cut. The
 *   reader cleans again with the set of the day. When the set cannot be read,
 *   or a text cannot be cleaned, the row is still written (so every claim
 *   still ends in a row) with its texts, its reason and every string of its
 *   detail but item ids and hashes withheld, and `detail.textWithheld` saying
 *   why.
 * - HASHED. Each text's normalised hash (`memoryTextHash`) is computed from
 *   the whole text as stored, before any cut; it is what a forget and a
 *   history look rows up by.
 * - CAPPED. A text, previous text, reason or detail string keeps at most
 *   4 KiB (UTF-8, cut on a character boundary; `bytes` records the text's
 *   size before the cut). A detail keeps at most 32 KiB: items are left out
 *   from the end and counted in `omittedItems`.
 *
 * An event's free text belongs in `text`, `previousText` and
 * `detail.items[].text`; `reason` and the rest of `detail` carry codes, ids
 * and counts.
 *
 * Workflow-scope safe: the repository and the logger are deferred imports, so
 * importing this module reaches no Node module.
 */
import { memoryTextHash } from "@integrations/sdk";
import { storable } from "../../db/memory-storable.js";
import {
  MEMORY_AREA_STATUSES,
  MEMORY_ENTRY_STATUSES,
  MEMORY_EVENT_ACTOR_PATTERN,
  MEMORY_EVENT_ENTRY_KINDS,
  MEMORY_EVENT_KINDS,
  MEMORY_EVENT_SOURCES,
  MEMORY_STATE_KINDS,
  MEMORY_TOPICS,
  MEMORY_TRUSTS,
  type MemoryEventDetail,
  type MemoryEventDetailItem,
  type MemoryOpenDispute,
  type MemoryStateKind,
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

/** One event as a caller hands it over: texts in the clear, no hashes. */
interface MemoryEventInput
  extends Omit<MemoryEventRecord, "textHash" | "previousTextHash" | "detail" | "occurredAt"> {
  /** Names the entry the event is about when it carries no text of its own.
   *  Ignored when `text` is given: the hash is then the text's, as stored. */
  readonly textHash?: string | null;
  readonly detail?: MemoryEventDetail;
  /** When it happened: the time of the store call or the recall it records,
   *  taken before that call. Never the time of this write, which can come
   *  late: a forget made in between blanks the texts of anything that
   *  occurred before it. */
  readonly occurredAt: Date;
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
  /** When the store forgot it; the time of this call when omitted. */
  readonly occurredAt?: Date;
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

/** At most this many UTF-8 bytes of one text, previous text, reason or detail string. */
export const MAX_MEMORY_LEDGER_TEXT_BYTES = 4 * 1024;
/** At most this many UTF-8 bytes of one event's detail, as the column prints it. */
export const MAX_MEMORY_LEDGER_DETAIL_BYTES = 32 * 1024;

async function connectedRepository(): Promise<MemoryLedgerRepository> {
  const { connectedMemoryLedgerRepository } = await import("../../db/repositories/memory-entry-state.js");
  return connectedMemoryLedgerRepository();
}

const pinoWarn: MemoryLedgerLog = (fields, message) => {
  void import("../../infra/logger.js")
    .then(({ logger }) => logger.warn(fields, message))
    .catch(() => {});
};

const utf8 = new TextEncoder();
const byteSize = (text: string) => utf8.encode(text).length;

/** The text within `max` UTF-8 bytes, cut at the start of a character. The
 *  text is well formed by then, so the bytes decode back exactly. */
function cutToBytes(text: string, max: number): string {
  const bytes = utf8.encode(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

const cut = (text: string) => cutToBytes(text, MAX_MEMORY_LEDGER_TEXT_BYTES);

/** Every string and key of a detail cut to size. */
function cutStrings<T>(value: T): T {
  return cleanStrings(value, cut);
}

/** The UTF-8 size of a JSON value as Postgres prints a jsonb column, with a
 *  space after every `:` and `,`: the size a reader of the row gets. */
function jsonbTextBytes(value: unknown): number {
  const listed = (sizes: number[]) => 2 + sizes.reduce((sum, size) => sum + size, 0) + 2 * Math.max(sizes.length - 1, 0);
  if (Array.isArray(value)) return listed(value.map((item) => jsonbTextBytes(item)));
  if (value !== null && typeof value === "object") {
    return listed(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => byteSize(JSON.stringify(key)) + 2 + jsonbTextBytes(item)),
    );
  }
  return byteSize(JSON.stringify(value) ?? "null");
}

/**
 * The detail within its size: whole when it fits; otherwise its first items,
 * in order, as many as fit, and `omittedItems` for the rest. When even the
 * rest of it does not fit, only its size is kept.
 */
function cappedDetail(detail: MemoryEventDetail): MemoryEventDetail {
  const size = jsonbTextBytes(detail);
  if (size <= MAX_MEMORY_LEDGER_DETAIL_BYTES) return detail;
  const items = detail.items ?? [];
  let used = jsonbTextBytes({ ...detail, items: [], omittedItems: items.length });
  if (used > MAX_MEMORY_LEDGER_DETAIL_BYTES) {
    return {
      ...(detail.textWithheld === undefined ? {} : { textWithheld: detail.textWithheld }),
      omittedDetail: size,
    };
  }
  const kept: MemoryEventDetailItem[] = [];
  for (const item of items) {
    const itemSize = jsonbTextBytes(item) + (kept.length === 0 ? 0 : 2);
    if (used + itemSize > MAX_MEMORY_LEDGER_DETAIL_BYTES) break;
    used += itemSize;
    kept.push(item);
  }
  return { ...detail, items: kept, omittedItems: items.length - kept.length };
}

/** The strings a withheld row keeps: what finds an item, never what it says. */
const WITHHELD_ITEM_KEEPS = new Set(["id", "entryId", "entryKey", "textHash"]);

/** Every string of a value as null. */
function withoutStrings<T>(value: T): T {
  if (typeof value === "string") return null as T;
  if (Array.isArray(value)) return value.map((item) => withoutStrings(item)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutStrings(item)])) as T;
  }
  return value;
}

/** A detail whose words could not be cleaned: every string goes but the ids
 *  and hashes of its items. */
function withheldDetail(detail: MemoryEventDetail | undefined, why: MemoryTextWithheld): MemoryEventDetail {
  const { items, ...rest } = detail ?? {};
  return {
    ...withoutStrings(rest),
    ...(items === undefined
      ? {}
      : {
          items: items.map((item) =>
            Object.fromEntries(
              Object.entries(item).map(([key, value]) => [
                key,
                WITHHELD_ITEM_KEEPS.has(key) ? value : withoutStrings(value),
              ]),
            ),
          ),
        }),
    textWithheld: why,
  };
}

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
  readonly addedDisputes?: readonly MemoryOpenDispute[];
}

/**
 * An event's words cleaned: its texts, its reason and every string and key of
 * its detail. Its addresses (run, subject, store, ids, keys) are compared
 * exactly elsewhere and are never rewritten.
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
  const disputes = (list: readonly MemoryOpenDispute[] | undefined) =>
    list?.map((dispute) => cleanDispute(dispute, clean));
  return {
    events: texts.events.map((event) => cleanEvent(event, clean)),
    aliasText: optional(texts.aliasText),
    moveToText: optional(texts.moveToText),
    forgetText: optional(texts.forgetText),
    disputes: disputes(texts.disputes),
    changeDisputes: disputes(texts.changeDisputes),
    addedDisputes: disputes(texts.addedDisputes),
  };
}

/** A dispute's addresses stay as they are; its words are cleaned and cut. */
function cleanDispute(dispute: MemoryOpenDispute, clean: (text: string) => string): MemoryOpenDispute {
  return { ...dispute, reason: dispute.reason === null ? null : cut(clean(dispute.reason)) };
}

/** Texts that could not be cleaned are not stored. Hashes are still taken
 *  from them (in `toRecord`), so a forget and a history still find the row. */
function withholdTexts(texts: WriteTexts): WriteTexts {
  const withoutReason = (list: readonly MemoryOpenDispute[] | undefined) =>
    list?.map((dispute) => ({ ...dispute, reason: null }));
  return {
    ...texts,
    disputes: withoutReason(texts.disputes),
    changeDisputes: withoutReason(texts.changeDisputes),
    addedDisputes: withoutReason(texts.addedDisputes),
  };
}

async function hashOf(text: string | null | undefined): Promise<string | null> {
  return typeof text === "string" ? memoryTextHash(text) : null;
}

/**
 * One event as stored: hashed from its whole texts, then withheld (every word
 * gone) or cut to size, then its detail capped.
 */
async function toRecord(event: MemoryEventInput, withheld: MemoryTextWithheld | undefined): Promise<MemoryEventRecord> {
  const textHash = (await hashOf(event.text)) ?? event.textHash ?? null;
  const previousTextHash = await hashOf(event.previousText);
  const items = event.detail?.items;
  const hashedItems =
    items === undefined
      ? undefined
      : await Promise.all(
          items.map(async (item): Promise<MemoryEventDetailItem> =>
            typeof item.text === "string"
              ? Object.assign({}, item, { textHash: await memoryTextHash(item.text) })
              : item,
          ),
        );
  const detail =
    event.detail === undefined && withheld === undefined
      ? undefined
      : { ...event.detail, ...(hashedItems === undefined ? {} : { items: hashedItems }) };
  const hashed = { ...event, textHash, previousTextHash };
  if (withheld !== undefined) {
    return {
      ...hashed,
      text: null,
      previousText: null,
      reason: null,
      detail: cappedDetail(withheldDetail(detail, withheld)),
    };
  }
  const textBytes = typeof event.text === "string" ? byteSize(event.text) : 0;
  return {
    ...hashed,
    text: typeof event.text === "string" ? cut(event.text) : null,
    previousText: typeof event.previousText === "string" ? cut(event.previousText) : null,
    reason: typeof event.reason === "string" ? cut(event.reason) : (event.reason ?? null),
    bytes: event.bytes ?? (textBytes > MAX_MEMORY_LEDGER_TEXT_BYTES ? textBytes : null),
    ...(detail === undefined ? {} : { detail: cappedDetail(cutStrings(detail)) }),
  };
}

function runIdsOf(events: readonly MemoryEventInput[]): string[] {
  return [...new Set(events.flatMap((event) => (event.runId === null ? [] : [event.runId])))];
}

const EVENT_WORDS = new Set<string>(MEMORY_EVENT_KINDS);
const SOURCE_WORDS = new Set<string>(MEMORY_EVENT_SOURCES);
const EVENT_ENTRY_KIND_WORDS = new Set<string>(MEMORY_EVENT_ENTRY_KINDS);
const STATE_KIND_WORDS = new Set<string>(MEMORY_STATE_KINDS);
const TOPIC_WORDS = new Set<string>(MEMORY_TOPICS);
const TRUST_WORDS = new Set<string>(MEMORY_TRUSTS);
const STATUS_WORDS = new Set<string>(MEMORY_ENTRY_STATUSES);
const AREA_STATUS_WORDS = new Set<string>(MEMORY_AREA_STATUSES);

/** The fields of an event whose word is outside the vocabulary. */
function unknownEventWords(event: MemoryEventInput): string[] {
  const unknown: string[] = [];
  const optional = (field: string, value: string | null | undefined, words: ReadonlySet<string>) => {
    if (value != null && !words.has(value)) unknown.push(field);
  };
  if (!EVENT_WORDS.has(event.event)) unknown.push("event");
  if (!MEMORY_EVENT_ACTOR_PATTERN.test(event.actor)) unknown.push("actor");
  optional("source", event.source, SOURCE_WORDS);
  optional("kind", event.kind, EVENT_ENTRY_KIND_WORDS);
  optional("topic", event.topic, TOPIC_WORDS);
  return unknown;
}

/** The fields of a state write whose word is outside the vocabulary. */
function unknownStateWords(state: {
  readonly kind?: string;
  readonly topic?: string;
  readonly areaStatus?: string;
  readonly trust?: string;
  readonly status?: string;
}): string[] {
  const checks: Array<[string, string | undefined, ReadonlySet<string>]> = [
    ["kind", state.kind, STATE_KIND_WORDS],
    ["topic", state.topic, TOPIC_WORDS],
    ["areaStatus", state.areaStatus, AREA_STATUS_WORDS],
    ["trust", state.trust, TRUST_WORDS],
    ["status", state.status, STATUS_WORDS],
  ];
  return checks.flatMap(([field, value, words]) => (value !== undefined && !words.has(value) ? [field] : []));
}

/** Only what identifies a failure: never the message, which drizzle builds
 *  from the statement and its parameters, the texts. */
function failureFields(error: unknown): Record<string, unknown> {
  const name =
    error instanceof Error ? (error.name !== "Error" ? error.name : error.constructor.name) : typeof error;
  let code: string | undefined;
  let constraint: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const at = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (code === undefined && typeof at.code === "string") code = at.code;
    if (constraint === undefined && typeof at.constraint === "string") constraint = at.constraint;
    current = at.cause;
  }
  return { error: name, ...(code === undefined ? {} : { code }), ...(constraint === undefined ? {} : { constraint }) };
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
          rows: events.length,
          ...fields,
        },
        message,
      );
    } catch {
      // A log that cannot be written is not a reason to throw out of a step.
    }
  };

  /** Make storable, then clean or withhold, every text of one write, reading the set once. */
  async function prepare(raw: WriteTexts): Promise<Cleaned<WriteTexts>> {
    const texts = storable(raw);
    const cleaned = await takeOutKnownSecrets((clean) => cleanTexts(texts, clean), knownSecrets());
    if (cleaned.ok) return { value: cleaned.value };
    say(texts.events, { withheld: cleaned.why }, "memory ledger texts withheld: they could not be cleaned of secrets");
    return { value: withholdTexts(texts), withheld: cleaned.why };
  }

  async function records(texts: Cleaned<WriteTexts>): Promise<MemoryEventRecord[]> {
    return Promise.all(texts.value.events.map((event) => toRecord(event, texts.withheld)));
  }

  /** Runs a write; a word outside the vocabulary or any throw becomes
   *  `{ ok: false }` and one log line. */
  async function bestEffort<T>(
    events: readonly MemoryEventInput[],
    unknownWords: readonly string[],
    write: () => Promise<T>,
  ): Promise<T | { readonly ok: false }> {
    if (unknownWords.length > 0) {
      say(events, { unknown: unknownWords }, "memory ledger write refused: a word outside the memory vocabulary");
      return { ok: false };
    }
    try {
      return await write();
    } catch (error) {
      say(events, failureFields(error), "memory ledger write failed");
      return { ok: false };
    }
  }

  const eventWords = (events: readonly MemoryEventInput[]) => [...new Set(events.flatMap(unknownEventWords))];

  /** A state write refused for a reason its caller may not look at, or one
   *  that landed keeping another store id, is one line: what happened, never
   *  a text. A duplicate is a retry that already landed; `not_found` is an
   *  answer the caller asked for. */
  const reportState = (events: readonly MemoryEventInput[], written: MemoryEntryStateWrite) => {
    if (!written.applied && written.why !== "duplicate" && written.why !== "not_found") {
      say(events, { why: written.why, storedVersion: written.storedVersion }, "memory entry state not written");
    } else if (written.applied && written.storeIdConflicts !== undefined) {
      say(events, { storeIdConflicts: written.storeIdConflicts }, "memory entry state kept its store id");
    }
  };

  const withheldField = (withheld: MemoryTextWithheld | undefined) =>
    withheld === undefined ? {} : { withheld };

  /** A change with its dispute reasons cleaned. */
  const cleanedChange = (change: MemoryEntryStateChange | undefined, texts: WriteTexts) =>
    change === undefined
      ? undefined
      : {
          ...change,
          ...(texts.changeDisputes === undefined ? {} : { openDisputes: texts.changeDisputes }),
          ...(texts.addedDisputes === undefined ? {} : { addOpenDisputes: texts.addedDisputes }),
        };

  return {
    record(events) {
      return bestEffort(events, eventWords(events), async () => {
        if (events.length === 0) return { ok: true as const, ids: [], duplicates: 0 };
        const texts = await prepare({ events });
        const appended = await (await repository()).appendEvents(await records(texts));
        return { ok: true as const, ...appended, ...withheldField(texts.withheld) };
      });
    },

    recordEntryState(input) {
      const create = { ...defaultMemoryEntryState(input.origin), ...input.create };
      const unknown = [
        ...eventWords(input.events),
        ...unknownStateWords({ ...create, kind: input.kind }),
        ...unknownStateWords(input.change ?? {}),
      ];
      return bestEffort(input.events, [...new Set(unknown)], async () => {
        const texts = await prepare({
          events: input.events,
          aliasText: input.text,
          disputes: create.openDisputes,
          changeDisputes: input.change?.openDisputes,
          addedDisputes: input.change?.addOpenDisputes,
        });
        const textHash = await aliasHash(texts.value.aliasText, input.textHash);
        const change = cleanedChange(input.change, texts.value);
        const written = await (await repository()).recordEntryState({
          alias: { subject: input.subject, kind: input.kind, textHash },
          create: { ...create, openDisputes: texts.value.disputes ?? [] },
          ...(change === undefined ? {} : { change }),
          ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
          events: await records(texts),
        });
        reportState(input.events, written);
        return { ok: true as const, ...written, ...withheldField(texts.withheld) };
      });
    },

    changeEntryState(input) {
      const unknown = [
        ...eventWords(input.events),
        ...unknownStateWords({ ...input.change, ...("kind" in input.target ? { kind: input.target.kind } : {}) }),
      ];
      return bestEffort(input.events, [...new Set(unknown)], async () => {
        const texts = await prepare({
          events: input.events,
          aliasText: "text" in input.target ? input.target.text : undefined,
          moveToText: input.moveTo !== undefined && "text" in input.moveTo ? input.moveTo.text : undefined,
          changeDisputes: input.change?.openDisputes,
          addedDisputes: input.change?.addOpenDisputes,
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
        const change = cleanedChange(input.change, texts.value);
        const written = await (await repository()).changeEntryState({
          target,
          ...(change === undefined ? {} : { change }),
          ...(moveTo === undefined ? {} : { moveTo }),
          ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
          events: await records(texts),
        });
        reportState(input.events, written);
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
        occurredAt: input.occurredAt ?? new Date(),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      };
      const unknown = [...eventWords([event]), ...unknownStateWords({ kind: input.kind })];
      return bestEffort([event], [...new Set(unknown)], async () => {
        const texts = await prepare({ events: [event], forgetText: input.text });
        const textHash = await aliasHash(texts.value.forgetText, input.textHash);
        const [record] = await records(texts);
        const forgotten = await (await repository()).forgetText({
          textHash,
          subject: input.subject,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          // The forget's row keeps its reason: it is the tombstone's code.
          events: [{ ...record!, reason: "forgotten", textHash }],
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
