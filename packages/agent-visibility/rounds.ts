/**
 * Clarification Rounds: every repository question of a subject, with every
 * delivery of an answer, how each was read, what was posted back, and what the
 * record did.
 *
 * Assembled from three kinds of rows the worker already keeps: the
 * clarification requests (the question), the answer deliveries (each distinct
 * arrival of words) and the Decision Trail (what the record did). Assembling
 * here rather than in the worker is what lets the dashboard and MCP show one
 * history.
 *
 * NOTHING HERE SANITIZES. The words, questions and notes are shown as the rows
 * hold them; removing secrets from them is the read model's job before it
 * serves a round (stage 3a). Long text is clamped and long lists are listed
 * from the start and counted, never refused.
 *
 * ONE BAD ROW NEVER COSTS THE SUBJECT. Each row is read on its own; a row that
 * cannot be read is left out, named in `skipped`, and counted on the round it
 * belongs to (`skippedRows`), so every other round still shows.
 *
 * A round is served as a header (`clarificationRoundHeader`) plus its
 * deliveries and its effects, each a list of its own (`pageList`).
 */
import { z } from "zod";
import type { WorkScopeAnswerReading, WorkScopeTrailEvent } from "@shared/contracts";
import {
  AGENT_VISIBILITY_LABEL_MAX_LENGTH,
  AGENT_VISIBILITY_MESSAGE_MAX_LENGTH,
  CLARIFICATION_NOTE_MAX_LENGTH,
  CLARIFICATION_QUESTION_MAX_LENGTH,
  CLARIFICATION_READING_KEYS_MAX,
  CLARIFICATION_ROUND_ASKS_MAX,
  CLARIFICATION_ROUND_OFFERED_MAX,
  CLARIFICATION_ROUND_QUESTIONS_MAX,
  CLARIFICATION_WORDS_MAX_LENGTH,
} from "./limits";
import {
  byteCountSchema,
  clampText,
  repositoryKeyReadSchema,
  visibilityIdSchema,
  visibilityTimestampSchema,
  type Assignable,
} from "./primitives";
import { describeIssues } from "./read";
import { AgentVisibilityInputError } from "./redact";
import { visibilitySlugSchema } from "./vocabulary";

/**
 * How one answer was read, as `workScopeAnswerReadingSchema` in
 * `@shared/contracts` writes it, read with open slugs and bounded strings so a
 * new outcome kind still opens. Lists past their ceiling are listed from the
 * start and counted.
 */
export const clarificationReadingSchema = z.object({
  version: z.number().int(),
  outcome: z.object({
    kind: visibilitySlugSchema,
    repositoryKeys: z.array(repositoryKeyReadSchema).max(CLARIFICATION_READING_KEYS_MAX).optional(),
    /** Every key the reading named; present with `repositoryKeys`. */
    repositoryKeyCount: byteCountSchema.optional(),
    repositoryKey: repositoryKeyReadSchema.optional(),
    paraphrase: z.string().max(AGENT_VISIBILITY_MESSAGE_MAX_LENGTH).optional(),
  }),
  /** `model`, or `deterministic` when the provider could not be reached. */
  readBy: visibilitySlugSchema,
  model: z.string().max(AGENT_VISIBILITY_LABEL_MAX_LENGTH).optional(),
  readAt: visibilityTimestampSchema,
  unofferedNames: z
    .array(z.string().max(AGENT_VISIBILITY_LABEL_MAX_LENGTH))
    .max(CLARIFICATION_READING_KEYS_MAX)
    .optional(),
  /** Every name; present with `unofferedNames`. */
  unofferedNameCount: byteCountSchema.optional(),
});
export type ClarificationReading = z.infer<typeof clarificationReadingSchema>;
// The write contract must stay readable through the view above.
// oxlint-disable-next-line no-unused-vars -- a compile-time check, not a type anything uses
type ReadingReadsAsView = Assignable<WorkScopeAnswerReading, ClarificationReading>;

/**
 * One distinct delivery of an answer. Consecutive identical arrivals (the Jira
 * path re-composes the same answer on every poll tick) are one delivery with a
 * count; the same words after different ones are a new delivery.
 */
export const clarificationDeliverySchema = z.object({
  clarificationId: visibilityIdSchema,
  words: z.string().max(CLARIFICATION_WORDS_MAX_LENGTH),
  /** `CLARIFICATION_AUTHOR_KINDS`; `display` is the name a person sees. */
  author: z.object({
    kind: visibilitySlugSchema,
    display: z.string().max(AGENT_VISIBILITY_LABEL_MAX_LENGTH),
  }),
  /** `CLARIFICATION_DELIVERY_SURFACES`. */
  surface: visibilitySlugSchema,
  firstAt: visibilityTimestampSchema,
  lastAt: visibilityTimestampSchema,
  count: z.number().int().min(1),
  /** Null when the answer was not read (a question not about repositories). */
  reading: clarificationReadingSchema.nullable(),
  /** What was posted back to the person, or null when nothing was. */
  note: z.string().max(CLARIFICATION_NOTE_MAX_LENGTH).nullable(),
  /**
   * The store had already merged arrivals of these words across another
   * delivery of the same clarification (A, B, A stored as A twice and B), so
   * the order in which a person said things is lost for this one. The
   * delivery sits at its latest arrival.
   */
  mergeConflict: z.boolean(),
});
export type ClarificationDelivery = z.infer<typeof clarificationDeliverySchema>;

const askSchema = z.object({
  clarificationId: visibilityIdSchema,
  runId: visibilityIdSchema,
  nodeId: visibilityIdSchema.nullable(),
  askedAt: visibilityTimestampSchema,
  /** `CLARIFICATION_ROUND_STATUSES`, as the read model decided it. */
  status: visibilitySlugSchema,
});

/** A trail event of the round's clarification, kept whole with an open `kind`;
 *  parse `event` with `workScopeTrailEventSchema` from `@shared/contracts` to
 *  render it in full. */
export const clarificationEffectSchema = z.object({
  trailId: z.number().int().min(1),
  at: visibilityTimestampSchema,
  clarificationId: visibilityIdSchema,
  event: z.object({ kind: visibilitySlugSchema }).passthrough(),
});
export type ClarificationEffect = z.infer<typeof clarificationEffectSchema>;

const roundFieldsSchema = z.object({
  /** The clarification id of the first ask. */
  id: visibilityIdSchema,
  /** The status of the latest ask. */
  status: visibilitySlugSchema,
  question: z.object({
    /** The first questions of the first ask, each clamped. */
    questions: z.array(z.string().max(CLARIFICATION_QUESTION_MAX_LENGTH)).max(CLARIFICATION_ROUND_QUESTIONS_MAX),
    questionCount: byteCountSchema,
    askedAt: visibilityTimestampSchema,
    /** The first repositories the question put in front of a person; an empty
     *  list is a repository question that named none, null a question that
     *  was not about repositories. `offeredCount` counts them all, null with
     *  `offered`. */
    offered: z
      .array(
        z.object({
          key: repositoryKeyReadSchema,
          askedBecause: visibilitySlugSchema,
          /** Did the question's words show this key? Null when not recorded. */
          named: z.boolean().nullable(),
        }),
      )
      .max(CLARIFICATION_ROUND_OFFERED_MAX)
      .nullable(),
    offeredCount: byteCountSchema.nullable(),
    purpose: visibilitySlugSchema.nullable(),
    /** A retried attempt wrote the same question again. */
    askedAgain: z.boolean(),
  }),
  /** The first ask and the newest ones, in time order; `askCount` counts all. */
  asks: z.array(askSchema).min(1).max(CLARIFICATION_ROUND_ASKS_MAX),
  askCount: z.number().int().min(1),
  /** Distinct deliveries and total arrivals. */
  deliveryCount: byteCountSchema,
  arrivalCount: byteCountSchema,
  /** Rows of this round's clarifications (deliveries, trail events, asks)
   *  that could not be read and are not shown; each is named in `skipped`. */
  skippedRows: byteCountSchema,
});

export const clarificationRoundSchema = roundFieldsSchema.extend({
  /** Every delivery, ordered by its latest arrival. */
  deliveries: z.array(clarificationDeliverySchema),
  /** The Decision Trail events of this clarification but the question itself,
   *  in trail order. */
  effects: z.array(clarificationEffectSchema),
});
export type ClarificationRound = z.infer<typeof clarificationRoundSchema>;

/** A round without its deliveries and effects, which are served as lists. */
export const clarificationRoundHeaderSchema = roundFieldsSchema.extend({
  effectCount: byteCountSchema,
});
export type ClarificationRoundHeader = z.infer<typeof clarificationRoundHeaderSchema>;

export function clarificationRoundHeader(round: ClarificationRound): ClarificationRoundHeader {
  return {
    id: round.id,
    status: round.status,
    question: round.question,
    asks: round.asks,
    askCount: round.askCount,
    deliveryCount: round.deliveryCount,
    arrivalCount: round.arrivalCount,
    skippedRows: round.skippedRows,
    effectCount: round.effects.length,
  };
}

const parsableTimestamp = visibilityTimestampSchema.refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be an ISO 8601 time",
});

/** One clarification request row. Lists of any length: they are listed from
 *  the start and counted when the round is assembled. */
const questionRowSchema = z.object({
  clarificationId: visibilityIdSchema,
  runId: visibilityIdSchema,
  nodeId: visibilityIdSchema.nullable(),
  questions: z.array(z.string()),
  askedAt: parsableTimestamp,
  status: visibilitySlugSchema,
  offered: z
    .array(z.object({ key: repositoryKeyReadSchema, askedBecause: visibilitySlugSchema, named: z.boolean().optional() }))
    .nullable(),
});

/** A reading as a row holds it, lists and text of any length. */
const readingRowSchema = z.object({
  version: z.number().int(),
  outcome: z.object({
    kind: visibilitySlugSchema,
    repositoryKeys: z.array(repositoryKeyReadSchema).optional(),
    repositoryKey: repositoryKeyReadSchema.optional(),
    paraphrase: z.string().optional(),
  }),
  readBy: visibilitySlugSchema,
  model: z.string().optional(),
  readAt: visibilityTimestampSchema,
  unofferedNames: z.array(z.string()).optional(),
});

/** An answer delivery, raw or already merged by the store (`count`, `lastAt`). */
const deliveryRowSchema = z.object({
  clarificationId: visibilityIdSchema,
  words: z.string(),
  author: z.object({ kind: visibilitySlugSchema, display: z.string() }),
  surface: visibilitySlugSchema,
  firstAt: parsableTimestamp,
  lastAt: parsableTimestamp.optional(),
  count: z.number().int().min(1).optional(),
  reading: readingRowSchema.nullable(),
  note: z.string().nullable(),
});

/** A Decision Trail row of the subject; one naming no clarification (a manual
 *  edit) belongs to no round. */
const trailRowSchema = z.object({
  id: z.number().int().min(1),
  at: visibilityTimestampSchema,
  event: z.object({ kind: visibilitySlugSchema }).passthrough(),
});

/** What the read model passes: the rows of one subject, in any order. */
export interface ClarificationRoundRows {
  questions: z.input<typeof questionRowSchema>[];
  deliveries: z.input<typeof deliveryRowSchema>[];
  trail: z.input<typeof trailRowSchema>[];
}
// A contract trail event must be passable as a trail row's event.
// oxlint-disable-next-line no-unused-vars -- a compile-time check, not a type anything uses
type TrailEventPassable = Assignable<WorkScopeTrailEvent, ClarificationRoundRows["trail"][number]["event"]>;

const rowCollectionsSchema = z.object({
  questions: z.array(z.unknown()),
  deliveries: z.array(z.unknown()),
  trail: z.array(z.unknown()),
});

/** A row left out because it could not be read, or a round left out because
 *  it could not be assembled. `problem` names fields, never quotes the row. */
export interface ClarificationRoundSkip {
  rows: "questions" | "deliveries" | "trail" | "round";
  /** Its position in the collection it came from (for a round, of its first
   *  question row among those read). */
  position: number;
  clarificationId: string | null;
  problem: string;
}

export interface ClarificationRoundsAssembly {
  rounds: ClarificationRound[];
  skipped: ClarificationRoundSkip[];
}

type QuestionRow = z.output<typeof questionRowSchema>;
type DeliveryRow = z.output<typeof deliveryRowSchema>;
type TrailRow = z.output<typeof trailRowSchema>;

/** A person's words were taken for these: a later ask of the same question is
 *  a new round, not the same one asked again. */
const ANSWERED_STATUSES = new Set(["answered", "resume_failed"]);

const time = (value: string) => Date.parse(value);

/** The same question: same run, same block, same words, same offered keys. */
function sameQuestion(left: QuestionRow, right: QuestionRow): boolean {
  const keys = (row: QuestionRow) =>
    row.offered === null ? null : JSON.stringify(row.offered.map((entry) => entry.key).sort());
  return (
    left.runId === right.runId &&
    left.nodeId === right.nodeId &&
    JSON.stringify(left.questions) === JSON.stringify(right.questions) &&
    keys(left) === keys(right)
  );
}

/** A reading as a round shows it: text clamped, lists listed from the start
 *  and counted. */
function readingView(reading: z.output<typeof readingRowSchema>): ClarificationReading {
  const { outcome } = reading;
  return {
    version: reading.version,
    outcome: {
      kind: outcome.kind,
      ...(outcome.repositoryKeys === undefined
        ? {}
        : {
            repositoryKeys: outcome.repositoryKeys.slice(0, CLARIFICATION_READING_KEYS_MAX),
            repositoryKeyCount: outcome.repositoryKeys.length,
          }),
      ...(outcome.repositoryKey === undefined ? {} : { repositoryKey: outcome.repositoryKey }),
      ...(outcome.paraphrase === undefined
        ? {}
        : { paraphrase: clampText(outcome.paraphrase, AGENT_VISIBILITY_MESSAGE_MAX_LENGTH) }),
    },
    readBy: reading.readBy,
    ...(reading.model === undefined ? {} : { model: clampText(reading.model, AGENT_VISIBILITY_LABEL_MAX_LENGTH) }),
    readAt: reading.readAt,
    ...(reading.unofferedNames === undefined
      ? {}
      : {
          unofferedNames: reading.unofferedNames
            .slice(0, CLARIFICATION_READING_KEYS_MAX)
            .map((name) => clampText(name, AGENT_VISIBILITY_LABEL_MAX_LENGTH)),
          unofferedNameCount: reading.unofferedNames.length,
        }),
  };
}

/** A delivery as it is merged, words still whole. */
interface Merging {
  row: DeliveryRow;
  firstAt: string;
  lastAt: string;
  count: number;
  reading: ClarificationReading | null;
  note: string | null;
  /** More than one row, or a row the store had merged already. */
  spansArrivals: boolean;
}

function sameDelivery(left: DeliveryRow, right: DeliveryRow): boolean {
  return (
    left.clarificationId === right.clarificationId &&
    left.words === right.words &&
    left.author.kind === right.author.kind &&
    left.author.display === right.author.display &&
    left.surface === right.surface
  );
}

/** Stable by input position where times tie. */
function byTime<T>(rows: readonly T[], at: (row: T) => string): T[] {
  return rows
    .map((row, position) => ({ row, position }))
    .sort((left, right) => time(at(left.row)) - time(at(right.row)) || left.position - right.position)
    .map((entry) => entry.row);
}

/**
 * Deliveries ordered by their latest arrival, consecutive identical ones
 * merged.
 *
 * A merged delivery keeps the reading and note of its first arrival, except
 * that a model's reading replaces an earlier deterministic one: the
 * deterministic reading is what answered while the provider was unreachable,
 * and the model is asked again on the next delivery of the same words
 * (`services/clarifications/answer-core.ts`).
 */
function mergeDeliveries(rows: readonly DeliveryRow[]): ClarificationDelivery[] {
  const merged: Merging[] = [];
  for (const row of byTime(rows, (entry) => entry.lastAt ?? entry.firstAt)) {
    const last = merged.at(-1);
    const rowLast = row.lastAt ?? row.firstAt;
    const count = row.count ?? 1;
    if (last && sameDelivery(last.row, row)) {
      last.count += count;
      last.spansArrivals = true;
      if (time(row.firstAt) < time(last.firstAt)) last.firstAt = row.firstAt;
      if (time(rowLast) > time(last.lastAt)) last.lastAt = rowLast;
      if ((last.reading === null || last.reading.readBy === "deterministic") && row.reading?.readBy === "model") {
        last.reading = readingView(row.reading);
        if (row.note !== null) last.note = row.note;
      }
      last.note ??= row.note;
      continue;
    }
    merged.push({
      row,
      firstAt: row.firstAt,
      lastAt: rowLast,
      count,
      reading: row.reading === null ? null : readingView(row.reading),
      note: row.note,
      spansArrivals: count > 1 || time(rowLast) > time(row.firstAt),
    });
  }
  const inside = (moment: string, entry: Merging) =>
    time(moment) > time(entry.firstAt) && time(moment) < time(entry.lastAt);
  return merged.map((entry) => ({
    clarificationId: entry.row.clarificationId,
    words: clampText(entry.row.words, CLARIFICATION_WORDS_MAX_LENGTH),
    author: {
      kind: entry.row.author.kind,
      display: clampText(entry.row.author.display, AGENT_VISIBILITY_LABEL_MAX_LENGTH),
    },
    surface: entry.row.surface,
    firstAt: entry.firstAt,
    lastAt: entry.lastAt,
    count: entry.count,
    reading: entry.reading,
    note: entry.note === null ? null : clampText(entry.note, CLARIFICATION_NOTE_MAX_LENGTH),
    mergeConflict:
      entry.spansArrivals &&
      merged.some(
        (other) =>
          other !== entry &&
          other.row.clarificationId === entry.row.clarificationId &&
          (inside(other.firstAt, entry) || inside(other.lastAt, entry)),
      ),
  }));
}

/** The clarification a raw row names, if it names one, read without trusting
 *  the row's shape. */
function clarificationIdOf(row: unknown, inEvent: boolean): string | null {
  if (row === null || typeof row !== "object") return null;
  const holder = inEvent ? (row as { event?: unknown }).event : row;
  if (holder === null || typeof holder !== "object") return null;
  const id = (holder as { clarificationId?: unknown }).clarificationId;
  return typeof id === "string" ? id : null;
}

/**
 * The rounds of one subject, oldest first, and the rows that could not be
 * read.
 *
 * A clarification written again by a retried attempt with the same question
 * (same run, block, words and offered keys, while the earlier one was never
 * answered) joins the earlier round as asked again. The same question after an
 * answer, or a different question, is a new round.
 *
 * Refuses only a value that is not the three collections of rows at all.
 */
export function assembleClarificationRounds(rows: ClarificationRoundRows): ClarificationRoundsAssembly {
  const collections = rowCollectionsSchema.safeParse(rows);
  if (!collections.success) {
    throw new AgentVisibilityInputError(
      `The round rows are not three lists of questions, deliveries and trail rows: ${describeIssues(collections.error.issues)}`,
    );
  }
  const skipped: ClarificationRoundSkip[] = [];
  const read = <T>(name: "questions" | "deliveries" | "trail", schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] =>
    collections.data[name].flatMap((row, position) => {
      const parsed = schema.safeParse(row);
      if (parsed.success) return [parsed.data];
      skipped.push({
        rows: name,
        position,
        clarificationId: clarificationIdOf(row, name === "trail"),
        problem: describeIssues(parsed.error.issues),
      });
      return [];
    });
  const questions = read("questions", questionRowSchema);
  const deliveries = read("deliveries", deliveryRowSchema);
  const trail: TrailRow[] = read("trail", trailRowSchema);
  const unreadable = [...skipped];

  const groups: QuestionRow[][] = [];
  for (const row of byTime(questions, (entry) => entry.askedAt)) {
    const group = groups.find((candidate) => {
      const latest = candidate.at(-1)!;
      return !ANSWERED_STATUSES.has(latest.status) && sameQuestion(latest, row);
    });
    if (group) group.push(row);
    else groups.push([row]);
  }

  const clarificationOf = (event: { kind: string } & Record<string, unknown>) =>
    typeof event.clarificationId === "string" ? event.clarificationId : null;
  const orderedTrail = [...trail].sort((left, right) => left.id - right.id);

  const rounds: ClarificationRound[] = [];
  groups.forEach((group) => {
    const first = group[0]!;
    const ids = new Set(group.map((row) => row.clarificationId));
    const roundTrail = orderedTrail.filter((row) => {
      const id = clarificationOf(row.event);
      return id !== null && ids.has(id);
    });
    const asked = roundTrail.find((row) => row.event.kind === "question_asked")?.event;
    const purpose = typeof asked?.purpose === "string" ? asked.purpose : null;
    const merged = mergeDeliveries(deliveries.filter((row) => ids.has(row.clarificationId)));
    // The first ask is the original; past the ceiling, the newest ones follow.
    const listedAsks = group.length <= CLARIFICATION_ROUND_ASKS_MAX
      ? group
      : [first, ...group.slice(group.length - (CLARIFICATION_ROUND_ASKS_MAX - 1))];
    const round: ClarificationRound = {
      id: first.clarificationId,
      status: group.at(-1)!.status,
      question: {
        questions: first.questions
          .slice(0, CLARIFICATION_ROUND_QUESTIONS_MAX)
          .map((text) => clampText(text, CLARIFICATION_QUESTION_MAX_LENGTH)),
        questionCount: first.questions.length,
        askedAt: first.askedAt,
        offered:
          first.offered === null
            ? null
            : first.offered.slice(0, CLARIFICATION_ROUND_OFFERED_MAX).map((entry) => ({
                key: entry.key,
                askedBecause: entry.askedBecause,
                named: entry.named ?? null,
              })),
        offeredCount: first.offered === null ? null : first.offered.length,
        purpose: purpose !== null && visibilitySlugSchema.safeParse(purpose).success ? purpose : null,
        askedAgain: group.length > 1,
      },
      asks: listedAsks.map((row) => ({
        clarificationId: row.clarificationId,
        runId: row.runId,
        nodeId: row.nodeId,
        askedAt: row.askedAt,
        status: row.status,
      })),
      askCount: group.length,
      deliveryCount: merged.length,
      arrivalCount: merged.reduce((total, entry) => total + entry.count, 0),
      skippedRows: unreadable.filter((entry) => entry.clarificationId !== null && ids.has(entry.clarificationId)).length,
      deliveries: merged,
      effects: roundTrail
        .filter((row) => row.event.kind !== "question_asked")
        .map((row) => ({
          trailId: row.id,
          at: row.at,
          clarificationId: clarificationOf(row.event)!,
          event: row.event,
        })),
    };
    const check = clarificationRoundSchema.safeParse(round);
    if (check.success) {
      rounds.push(round);
      return;
    }
    // The rows were read one by one, so this is a defect here; it costs this
    // round, named in `skipped`, and never the subject.
    skipped.push({
      rows: "round",
      position: questions.indexOf(first),
      clarificationId: first.clarificationId,
      problem: `the assembled round does not satisfy its own schema: ${describeIssues(check.error.issues)}`,
    });
  });
  return { rounds, skipped };
}
