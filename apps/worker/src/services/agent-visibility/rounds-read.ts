/**
 * The clarification rounds of one subject: the question, every distinct
 * delivery of an answer, and what each one did.
 *
 * ONE ASSEMBLY, THREE PAGES. A round is a group of asks of the same question,
 * so a page of asks could not be grouped without reading the ones it cut off:
 * the rows of a subject are read whole and grouped once, and the headers, a
 * round's deliveries and a round's effects are three pages over that one
 * assembly. The rows are small and a subject collects them one human question
 * at a time. That is also why `effectCount` on a header is the count of the
 * round's own trail events and owes nothing to the `trailLimit` a caller asked
 * the work scope record for.
 *
 * A round outlives the run that asked it, deliberately: it is the history of a
 * person's decision, not of an execution. Who may read it is still the run's
 * audience, because the question quotes whatever the run was working on.
 *
 * WHAT IS NORMALIZED ON THE WAY OUT. A delivery's words, note, author and
 * reading passed the capture detector when they were stored. A QUESTION and a
 * trail event's free text never did: they are composed from a ticket and from
 * block authoring, and MCP rewrites every string it serves. Both go through the
 * detector here so the two surfaces show the same bytes.
 */
import { createHash } from "node:crypto";

import {
  assembleClarificationRounds,
  clarificationRoundHeader,
  type ClarificationDelivery,
  type ClarificationEffect,
  type ClarificationRound,
  type ClarificationRoundHeader,
  type ClarificationRoundRows,
} from "@shared/agent-visibility";
import { canonicalSubjectKey } from "@shared/contracts";
import {
  listClarificationAnswerDeliveryRows,
  listClarificationQuestionRows,
  listConnectedClarificationAnswerDeliveryRows,
  listConnectedClarificationQuestionRows,
  listConnectedSubjectClarificationTrailRows,
  listSubjectClarificationTrailRows,
  readConnectedRunReadAudiences,
  readRunReadAudiences,
  type ClarificationAnswerDeliveryRow,
  type ClarificationQuestionRow,
  type SubjectTrailRow,
} from "../../db/repositories/agent-visibility.js";
import type { Db } from "../../db/types.js";
import {
  badRequest,
  dropUndefined,
  keyedListPage,
  notFound,
  pageLimit,
  type AgentVisibilityPage,
  type AgentVisibilityUnreadable,
} from "./pages.js";
import type { PageBounds } from "./briefing-read.js";
import { serveSafeText } from "./serve-safe.js";
import { knownSecretValues } from "../integrations/index.js";

export interface RoundReads {
  questions(subjectKey: string): Promise<ClarificationQuestionRow[]>;
  deliveries(clarificationIds: readonly string[]): Promise<ClarificationAnswerDeliveryRow[]>;
  trail(subjectKey: string): Promise<SubjectTrailRow[]>;
  audiences(runIds: readonly string[]): Promise<Map<string, string | null>>;
  /** Every secret the deployment knows, which everything served is redacted
   *  with. Throws when the integration settings cannot be read, and the read
   *  serves nothing rather than text redacted with part of the set. */
  knownSecrets(): Promise<string[]>;
}

export function roundReadsOf(db: Db): RoundReads {
  return {
    questions: (subjectKey) => listClarificationQuestionRows(db, subjectKey),
    deliveries: (ids) => listClarificationAnswerDeliveryRows(db, ids),
    trail: (subjectKey) => listSubjectClarificationTrailRows(db, subjectKey),
    audiences: (runIds) => readRunReadAudiences(db, runIds),
    knownSecrets: () => knownSecretValues({ db }),
  };
}

export const connectedRoundReads: RoundReads = {
  questions: listConnectedClarificationQuestionRows,
  deliveries: listConnectedClarificationAnswerDeliveryRows,
  trail: listConnectedSubjectClarificationTrailRows,
  audiences: readConnectedRunReadAudiences,
  knownSecrets: () => knownSecretValues(),
};

export interface AssembledRounds {
  rounds: ClarificationRound[];
  unreadable: AgentVisibilityUnreadable[];
  /** Delivery fingerprint -> the store's row serial, so a page of deliveries
   *  can key on a number nothing rewrites. */
  deliveryIds: Map<string, number>;
}

/** Every string of a trail event, made safe to serve. The event is kept whole
 *  (the package passes it through) so a reader can render a kind this build
 *  does not know, which means its free text is ours to normalize. */
function safeEvent(value: unknown, safe: (text: string) => string): unknown {
  if (typeof value === "string") return safe(value);
  if (Array.isArray(value)) return value.map((entry) => safeEvent(entry, safe));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, safeEvent(entry, safe)]),
    );
  }
  return value;
}

/**
 * Every round of a subject, oldest first, and the rows that could not be read.
 *
 * A subject with no clarification answers none, which is not an error.
 */
export async function assembleSubjectRounds(
  reads: RoundReads,
  input: { subjectKey: string; organizationId: string },
): Promise<AssembledRounds> {
  // The spelling the questions were recorded under, whatever case was typed.
  const subjectKey = canonicalSubjectKey(input.subjectKey);
  const all = await reads.questions(subjectKey);
  if (all.length === 0) return { rounds: [], unreadable: [], deliveryIds: new Map() };

  // THE SAME AUDIENCE AS THE REPLAY OF THE RUN THAT ASKED, decided per
  // clarification. A round quotes the ticket the run was working on, so one run
  // whose trace recorded no organization must not hide the nine rounds whose
  // runs are perfectly confirmable, and must not be answered by a row simply
  // being absent: the REQUESTED ids are walked, and an id the query did not
  // answer for is unconfirmable, never waved through.
  const wanted = [...new Set(all.map((row) => row.runId))];
  const audiences = await reads.audiences(wanted);
  const confirmed = new Set(
    wanted.filter((runId) => {
      const organizationId = audiences.get(runId);
      return organizationId !== undefined && organizationId === input.organizationId;
    }),
  );
  // A withheld round is named by its POSITION only. Its clarification id and
  // the id of the run that asked belong to whoever may read it, so they are not
  // handed to a caller who may not, not even inside an explanation.
  const withheld: AgentVisibilityUnreadable[] = [];
  const questions = all.filter((row, position) => {
    if (confirmed.has(row.runId)) return true;
    const organizationId = audiences.get(row.runId);
    withheld.push({
      rows: "questions",
      position,
      id: null,
      problem:
        organizationId === undefined || organizationId === null
          ? "the run that asked this round recorded no organization for its trace, so who may read it cannot be confirmed"
          : "this round was asked by a run of another organization",
    });
    return false;
  });
  // NOTHING READABLE AND SOMETHING ASKED reads as a subject this caller does
  // not have, in the same words a subject nobody has gets: an answer of "no
  // rounds, and here is why" would confirm that a question exists on a ticket
  // the caller cannot see. One unconfirmable round among readable ones is the
  // opposite case, and is served alongside them above.
  if (questions.length === 0) {
    throw notFound(
      `This installation has no clarification rounds for ${subjectKey} that you may read.`,
    );
  }

  const [deliveries, trail] = await Promise.all([
    reads.deliveries(questions.map((row) => row.clarificationId)),
    reads.trail(subjectKey),
  ]);
  const readable = new Set(questions.map((row) => row.clarificationId));
  const safe = serveSafeText(await reads.knownSecrets());
  const rows: ClarificationRoundRows = {
    questions: questions.map((row) => ({
      clarificationId: row.clarificationId,
      runId: row.runId,
      nodeId: row.nodeId,
      // Normalized BEFORE assembly, so the package's clamp applies to the text
      // a reader is really served and every view of the round agrees.
      questions: row.questions.map(safe),
      askedAt: row.askedAt.toISOString(),
      status: row.status,
      offered: row.offered,
    })),
    deliveries: deliveries.map((row) => ({
      clarificationId: row.clarificationId,
      words: row.words,
      author: { kind: row.authorKind, display: row.authorDisplay },
      surface: row.surface,
      firstAt: row.firstAt.toISOString(),
      lastAt: row.lastAt.toISOString(),
      count: row.count,
      reading: row.reading as ClarificationRoundRows["deliveries"][number]["reading"],
      note: row.note,
    })),
    // A trail row of a clarification nobody here may read goes with it.
    trail: trail
      .filter((row) => {
        const id = row.event.clarificationId;
        return typeof id !== "string" || readable.has(id);
      })
      .map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        event: safeEvent(row.event, safe) as SubjectTrailRow["event"],
      })),
  };
  const assembly = assembleClarificationRounds(rows);
  return {
    rounds: assembly.rounds,
    unreadable: [
      ...withheld,
      ...assembly.skipped.map((skip) => ({
        rows: skip.rows,
        position: skip.position,
        id: skip.clarificationId,
        problem: skip.problem,
      })),
    ],
    // The store's own serial for each delivery, which is the only handle a
    // page can key on that a later arrival cannot move (see below).
    deliveryIds: new Map(
      deliveries.map((row) => [
        deliveryFingerprint(row.clarificationId, row.firstAt.toISOString(), row.words),
        row.id,
      ]),
    ),
  };
}

/** What identifies one delivery across the package's merge: its clarification,
 *  its first arrival and its words. A later arrival changes `lastAt` and
 *  `count`, never these. */
function deliveryFingerprint(clarificationId: string, firstAt: string, words: string): string {
  return createHash("sha256")
    .update(`${clarificationId}\u0000${firstAt}\u0000${words}`, "utf8")
    .digest("hex");
}

export interface RoundPageInput {
  cursor?: string | null;
  limit?: number;
  bounds?: PageBounds;
}

/**
 * The round headers of a subject: each round without its deliveries and its
 * effects, which are pages of their own.
 *
 * Keyed on the round's own id, which is the clarification id of its first ask
 * and never changes: a question asked again between two pages joins its round
 * rather than inserting a new one, and a genuinely new round joins the end.
 */
export function roundHeadersPage(
  assembled: AssembledRounds,
  input: RoundPageInput,
): AgentVisibilityPage<ClarificationRoundHeader> {
  return dropUndefined(
    keyedListPage(assembled.rounds.map(clarificationRoundHeader), {
      keyOf: (header) => header.id,
      cursor: input.cursor ?? null,
      limit: pageLimit(input.limit, input.bounds),
      unreadable: assembled.unreadable,
    }),
  );
}

function roundOf(assembled: AssembledRounds, roundId: string): ClarificationRound {
  const round = assembled.rounds.find((candidate) => candidate.id === roundId);
  if (!round) {
    throw notFound(
      `This subject has no round ${roundId}. A round is named by the clarification id of its FIRST ask, which a later ask of the same question does not change; read the round headers again.`,
    );
  }
  return round;
}

/**
 * Every distinct delivery of one round's answer, ordered by its latest arrival.
 *
 * Consecutive identical arrivals are one delivery with a count, and a repeat
 * arrival MOVES its delivery to the end of that order, so a position could not
 * be a cursor here. The key is the delivery's own clarification, its first
 * arrival and the length of its words: the three things about a delivery that
 * a later arrival never changes.
 */
export function roundDeliveriesPage(
  assembled: AssembledRounds,
  roundId: string,
  input: RoundPageInput,
): AgentVisibilityPage<ClarificationDelivery> {
  return dropUndefined(
    keyedListPage(roundOf(assembled, roundId).deliveries, {
      keyOf: (delivery) => deliveryKey(assembled, delivery),
      cursor: input.cursor ?? null,
      limit: pageLimit(input.limit, input.bounds),
    }),
  );
}

/** The store's serial for this delivery, as an opaque cursor. Two arrivals in
 *  one millisecond carrying the same number of words would have collided on a
 *  key made of their own fields, and a collision serves a page twice. */
function deliveryKey(assembled: AssembledRounds, delivery: ClarificationDelivery): string {
  const fingerprint = deliveryFingerprint(
    delivery.clarificationId,
    delivery.firstAt,
    delivery.words,
  );
  const id = assembled.deliveryIds.get(fingerprint);
  return id === undefined ? fingerprint : String(id);
}

/** The Decision Trail events of one round's clarifications, in trail order.
 *  Keyed on the trail id, which is a serial nothing rewrites. */
export function roundEffectsPage(
  assembled: AssembledRounds,
  roundId: string,
  input: RoundPageInput,
): AgentVisibilityPage<ClarificationEffect> {
  return dropUndefined(
    keyedListPage(roundOf(assembled, roundId).effects, {
      keyOf: (effect) => String(effect.trailId),
      cursor: input.cursor ?? null,
      limit: pageLimit(input.limit, input.bounds),
    }),
  );
}

/** A round id as a caller may name one. Bounded here so a pathological value is
 *  refused before it is hashed into an audit row. */
export function checkedRoundId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw badRequest("roundId is the id of a round this subject has, at most 200 characters.");
  }
  return value;
}
