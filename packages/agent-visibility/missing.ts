/**
 * Why an attempt has no briefing for a send a person expected to see.
 *
 * Never a generic "not recorded": each answer points somewhere different. Not
 * sent yet means wait. Never sent means read the cause, and the failure with
 * it where there is one. Not recorded means we cannot show it, and says why.
 * Expired means we kept it and retention removed it.
 *
 * WHETHER THE PROMPT WENT OUT IS DECIDED FIRST, and only then whether we kept
 * it. A run that failed while preparing says "never sent" with its failure even
 * when capture was off or its code predates capture, because that is the
 * answer to "what did the agent get": nothing.
 *
 * The four kinds are closed because they are exhaustive (sent or not, kept or
 * not); what can grow is the cause under them, which is an open slug.
 */
import { z } from "zod";
import { AGENT_VISIBILITY_MESSAGE_MAX_LENGTH, AGENT_VISIBILITY_SCHEMA_VERSION } from "./limits";
import { clampText } from "./primitives";
import { visibilitySlugSchema } from "./vocabulary";

const version = z.literal(AGENT_VISIBILITY_SCHEMA_VERSION);

export const missingBriefingReasonSchema = z.discriminatedUnion("kind", [
  z.object({ schemaVersion: version, kind: z.literal("not_sent_yet") }),
  z.object({
    schemaVersion: version,
    kind: z.literal("never_sent"),
    /**
     * `NEVER_SENT_CAUSES`, read as a slug, and ABSENT on the commonest answer:
     * an attempt that ended before its prompt went out has a failure to read
     * rather than a cause. A build that does not know a cause still reads the
     * record, because zod leaves an unknown key out rather than refusing the
     * whole reason, and falls back to the attempt's own ending.
     */
    cause: visibilitySlugSchema.optional(),
    /** As the attempt row recorded it; null when the row is gone. */
    attemptState: visibilitySlugSchema.nullable(),
    runStatus: visibilitySlugSchema.nullable(),
    /** The recorded failure, safe text; null for a cancelled or skipped attempt. */
    failure: z
      .object({
        category: visibilitySlugSchema,
        message: z.string().max(AGENT_VISIBILITY_MESSAGE_MAX_LENGTH),
      })
      .nullable(),
  }),
  z.object({
    schemaVersion: version,
    kind: z.literal("not_recorded"),
    /** `NOT_RECORDED_CAUSES`, read as a slug. */
    cause: visibilitySlugSchema,
  }),
  z.object({ schemaVersion: version, kind: z.literal("expired") }),
]);
export type MissingBriefingReason = z.infer<typeof missingBriefingReasonSchema>;

/**
 * The facts the read model has about an attempt. Each is something recorded,
 * never inferred from a date or from today's settings.
 */
export interface MissingBriefingFacts {
  /** The attempt row's state, or null when the row is gone (its replay
   *  expired). `waiting_for_clarification` is a terminal, paused state: the
   *  row has its completion time. */
  attemptState: string | null;
  /** The run's status (`RunStatus`: `running`, `awaiting`, `success`,
   *  `failed`, `blocked`), or null when unknown. An attempt row can still say
   *  running on a run that failed or was cancelled. */
  runStatus: string | null;
  /** The failure recorded for the attempt, or for the run where the attempt
   *  recorded none. `beforeSend` when the failure is known to have happened
   *  before the prompt went out (preparing the sandbox, resolving inputs). */
  failure: { category: string; message: string; beforeSend?: boolean } | null;
  /** Whether the attempt's send step completed, when that is known. */
  promptSent: boolean | "unknown";
  /**
   * Whether this block's kind of send happens on EVERY attempt of it, or only
   * when the block cannot work the answer out itself.
   *
   * A property of the block type the run recorded, not of this attempt. Only
   * `prepare_workspace` is conditional today: it asks a model which
   * repositories a ticket touches only when selection resolved none, which is
   * why a ticket that names its repository leaves a finished attempt with
   * nothing recorded under it. True wherever the block type is unknown: a
   * silence we cannot name has to keep the older, louder answer.
   */
  sendsEveryAttempt: boolean;
  /**
   * Whether this RUN recorded a send whose write was lost.
   *
   * The run's own counter (`agent_briefing_runs.failed_count`), bumped by
   * capture on every outcome that kept nothing, which is what turns "this
   * attempt has no record" into "this attempt made no send": a run that lost
   * nothing cannot be hiding a send behind an empty attempt. Per run and not
   * per attempt, so a run that DID lose one keeps the louder answer for every
   * attempt of it.
   */
  runLostASend: boolean;
  /** Could the code this attempt ran capture briefings? Decided from the code
   *  version the attempt ran, never from a date, because a run pinned to an old
   *  deployment starts attempts long after a deploy. Null when unknown. */
  captureCapable: boolean | null;
  /** Capture was switched off for this attempt, as recorded when it ran. */
  captureDisabled: boolean;
  /** The kinds of the briefings this attempt did capture (the durable marker
   *  survives the replay). A discovery briefing proves the code could capture
   *  and still does not explain a planning pass that never went out. */
  capturedKinds: readonly string[];
  /** The run's replay, and its briefings with it, passed retention. */
  replayExpired: boolean;
}

const LIVE_ATTEMPT_STATES = new Set(["running", "waiting_loop"]);
const WAITING_FOR_ANSWER = "waiting_for_clarification";
const LIVE_RUN_STATUSES = new Set(["running", "awaiting"]);
const KNOWN_RUN_STATUSES = new Set(["running", "awaiting", "success", "failed", "blocked"]);
const ENDED_WITHOUT_COMPLETING_ATTEMPT_STATES = new Set(["failed", "cancelled", "skipped"]);
const ENDED_WITHOUT_COMPLETING_RUN_STATUSES = new Set(["failed", "blocked"]);

export function explainMissingBriefing(facts: MissingBriefingFacts): MissingBriefingReason {
  const schemaVersion = AGENT_VISIBILITY_SCHEMA_VERSION;
  const neverSent = (): MissingBriefingReason => ({
    schemaVersion,
    kind: "never_sent",
    attemptState: facts.attemptState,
    runStatus: facts.runStatus,
    failure: facts.failure && {
      category: facts.failure.category,
      message: clampText(facts.failure.message, AGENT_VISIBILITY_MESSAGE_MAX_LENGTH),
    },
  });
  const captured = facts.capturedKinds.length > 0;
  // Asked a person between discovery and its first pass: the pass is still
  // ahead. Any other briefing means the question came after a send.
  const waitingBeforePass =
    facts.attemptState === WAITING_FOR_ANSWER &&
    captured &&
    facts.capturedKinds.every((kind) => kind === "discovery");

  // 1. Still to come. A status this build does not know, like no status at
  // all, does not overrule the attempt row: the row is the fact recorded, and
  // "never sent" of a pass that then runs would be the worse mistake.
  const runLive =
    facts.runStatus === null || !KNOWN_RUN_STATUSES.has(facts.runStatus) || LIVE_RUN_STATUSES.has(facts.runStatus);
  const attemptLive = facts.attemptState !== null && LIVE_ATTEMPT_STATES.has(facts.attemptState);
  if (facts.promptSent !== true && runLive && (attemptLive || waitingBeforePass)) {
    return { schemaVersion, kind: "not_sent_yet" };
  }

  // 2. Over, and known not to have sent: whatever capture could do.
  if (facts.promptSent === false || facts.failure?.beforeSend === true) return neverSent();

  // 3. Sent, or not knowable: whether we kept it.
  if (facts.replayExpired && captured) return { schemaVersion, kind: "expired" };
  // A briefing written by this attempt proves its code could capture, whatever
  // else is known about its version.
  const capable = captured || facts.captureCapable === true;
  if (!capable) return { schemaVersion, kind: "not_recorded", cause: "predates_capture" };
  if (facts.captureDisabled) return { schemaVersion, kind: "not_recorded", cause: "capture_disabled" };

  // 4. The code could capture and capture was on, so a send leaves a
  // briefing. Where nobody recorded whether the send happened, an attempt
  // that ended without completing most likely never reached it.
  const runEndedWithoutCompleting =
    facts.runStatus !== null && ENDED_WITHOUT_COMPLETING_RUN_STATUSES.has(facts.runStatus);
  const endedWithoutCompleting =
    (facts.attemptState !== null && ENDED_WITHOUT_COMPLETING_ATTEMPT_STATES.has(facts.attemptState)) ||
    waitingBeforePass ||
    ((attemptLive || facts.attemptState === null) && runEndedWithoutCompleting);
  if (facts.promptSent === "unknown" && endedWithoutCompleting) return neverSent();

  // 5. A block that asks a model only when it needs to, an attempt of it that
  // finished, and no send recorded under it. NOTHING IS MISSING: this attempt
  // never asked. Reaching this line already means the send is not still ahead
  // (1), is not known to have failed before going out (2), and left no marker
  // row saying it went out at all, so the only two readings left are "it never
  // asked" and "it asked and we lost the record". The run's own counter tells
  // them apart, which is why this is a deduction and not a guess.
  if (facts.promptSent !== true && !facts.sendsEveryAttempt && !facts.runLostASend) {
    return {
      schemaVersion,
      kind: "never_sent",
      cause: "not_needed",
      attemptState: facts.attemptState,
      runStatus: facts.runStatus,
      // The attempt did not fail, so it has no failure to quote. A run that
      // failed later, somewhere else, is not this attempt's reason for asking
      // nothing, and quoting it here would read as one.
      failure: null,
    };
  }

  // The send happened, or the attempt completed, and nothing was written: the
  // write was refused or lost.
  return { schemaVersion, kind: "not_recorded", cause: "capture_skipped" };
}
