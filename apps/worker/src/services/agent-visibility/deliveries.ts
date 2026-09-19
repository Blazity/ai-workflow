import { DEFAULT_REDACTION_REPLACEMENT } from "@shared/agent-visibility";
import type { WorkScopeAnswerReading } from "@shared/contracts";
import {
  appendClarificationAnswerDelivery,
  appendConnectedClarificationAnswerDelivery,
  type AppendClarificationAnswerDeliveryResult,
  type ClarificationAnswerDeliveryInput,
} from "../../db/repositories/agent-visibility.js";
import type { Db } from "../../db/types.js";
import { logger } from "../../infra/logger.js";
import {
  configuredVisibilityDetector,
  redactForStorage,
  VisibilityCaptureRefusal,
} from "../../run-observability/visibility-detector.js";

/** Where a person's words really arrived, as the caller knows it and never as
 *  a guess from a label: somebody named "MCP Admin" answering in the dashboard
 *  answered in the dashboard. */
export type ClarificationDeliverySurface = "jira" | "dashboard" | "mcp" | "other";

export interface AnswerDeliveryRecord {
  clarificationId: string;
  /** For the log line, so a lost delivery can be found rather than counted. */
  runId: string;
  /** The words exactly as the channel delivered them. */
  words: string;
  author: { kind: "person" | "several_people"; display: string };
  surface: ClarificationDeliverySurface;
  /** The one reading of these words, or null where they were not read. */
  reading: WorkScopeAnswerReading | null;
  /** What was posted back to the person, or null when nothing was: a telling
   *  that failed to post never claims a note. */
  note: string | null;
  at?: Date;
}

export type RecordAnswerDeliveryOutcome =
  | { outcome: "appended" | "merged" }
  | { outcome: "not_recorded"; reason: string };

export interface RecordAnswerDeliveryOptions {
  /** An already-scoped client; production uses the connected one. */
  db?: Db;
  /** The detector; production reads the configured secrets from `process.env`. */
  sanitize?: Parameters<typeof redactForStorage>[1];
}

/**
 * How long a stored arrival may be.
 *
 * An answer longer than a clarification answer may be is still an arrival and
 * still gets its row, so a person who sent one sees what happened to it; what
 * the row does not do is carry an unbounded paste into the database. Applied
 * after the detector, so a cut can only ever fall inside a marker.
 */
const WORDS_MAX_LENGTH = 10_000;
const CUT_NOTE = "\n[cut: this answer was longer than an answer may be]";

function clampWords(words: string): string {
  return words.length <= WORDS_MAX_LENGTH ? words : words.slice(0, WORDS_MAX_LENGTH) + CUT_NOTE;
}

/** The reading as it is kept beside the words: its free text carries whatever
 *  a person wrote and a model paraphrased, so it meets the same detector. */
function redactReading(reading: WorkScopeAnswerReading, redact: (text: string) => string): unknown {
  const outcome = reading.outcome as { kind: string; paraphrase?: string };
  return {
    ...reading,
    outcome: outcome.paraphrase === undefined ? outcome : { ...outcome, paraphrase: redact(outcome.paraphrase) },
    ...(reading.model === undefined ? {} : { model: redact(reading.model) }),
    ...(reading.unofferedNames === undefined
      ? {}
      : { unofferedNames: reading.unofferedNames.map(redact) }),
  };
}

/**
 * Keep one arrival of an answer: the words as delivered, who delivered them,
 * through which surface, how they were read and what was posted back.
 *
 * NOTHING HERE MAY CHANGE WHAT AN ANSWER DOES. A missing table, a database
 * that is down, a detector that throws: each leaves the answer, the resume and
 * every comment exactly as they were, and says so in one log line. The record
 * of a delivery is worth a lot and never worth an answer.
 *
 * Everything stored passes the capture detector, because the rounds assembler
 * shows these rows as it finds them and a Jira comment may quote anything.
 */
export async function recordAnswerDelivery(
  delivery: AnswerDeliveryRecord,
  options: RecordAnswerDeliveryOptions = {},
): Promise<RecordAnswerDeliveryOutcome> {
  try {
    const sanitize = options.sanitize ?? configuredVisibilityDetector();
    // A field the detector cannot prove clean is stored as the marker rather
    // than lost with the whole arrival: that a person answered, when, and what
    // it did is worth more than the text of one field.
    const redact = (text: string) => {
      try {
        return redactForStorage(text, sanitize);
      } catch (error) {
        if (!(error instanceof VisibilityCaptureRefusal)) throw error;
        return DEFAULT_REDACTION_REPLACEMENT;
      }
    };
    const row: ClarificationAnswerDeliveryInput = {
      clarificationId: delivery.clarificationId,
      words: clampWords(redact(delivery.words)),
      authorKind: delivery.author.kind,
      authorDisplay: redact(delivery.author.display),
      surface: delivery.surface,
      reading: delivery.reading === null ? null : redactReading(delivery.reading, redact),
      note: delivery.note === null ? null : redact(delivery.note),
      at: delivery.at ?? new Date(),
    };
    const written: AppendClarificationAnswerDeliveryResult | null = options.db
      ? await appendClarificationAnswerDelivery(options.db, row)
      : await appendConnectedClarificationAnswerDelivery(row);
    if (written) return { outcome: written.outcome === "appended" ? "appended" : "merged" };
    const reason = "another delivery of this clarification kept winning the end of the chain";
    logger.warn(
      { runId: delivery.runId, clarificationId: delivery.clarificationId, surface: delivery.surface },
      "clarification_answer_delivery_not_recorded",
    );
    return { outcome: "not_recorded", reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // THE IDENTITY, NEVER THE PAYLOAD. A failed statement carries its own SQL
    // and its parameters, which here are the person's words: the log says
    // which arrival was lost and what kind of failure it was, and the caller
    // keeps the rest.
    logger.warn(
      {
        runId: delivery.runId,
        clarificationId: delivery.clarificationId,
        surface: delivery.surface,
        err: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: string }).code,
      },
      "clarification_answer_delivery_failed",
    );
    return { outcome: "not_recorded", reason };
  }
}
