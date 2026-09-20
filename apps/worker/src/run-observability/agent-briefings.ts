/**
 * Recording what one send gave a model, from inside the step that sent it.
 *
 * A FAILURE HERE NEVER FAILS A RUN. The send steps keep `maxRetries = 0`
 * (`engine/steps/phase.ts`), so a throw from this module would kill an agent
 * that is already starting. Everything is caught, logged with the run and the
 * attempt so a loss can be found rather than counted, and reported as an
 * outcome. Modelled on `engine/work-scope/apply-plans.ts`.
 *
 * It lives beside the detector rather than in `services/agent-visibility`
 * because the engine may not import a service (ADR-001, `scripts/gates/
 * tiers.json`); the service cluster re-exports it for the surfaces that read
 * briefings.
 *
 * EVERY WRITE TO THE TWO BRIEFING TABLES IS HERE: the briefing row, the marker
 * that says a send happened with nothing kept, and the run's durable facts. A
 * second writer is not a duplicate that merely costs a reader an extra file; it
 * is a second, quieter opinion about which outcomes deserve a run fact, and the
 * run fact is what later tells a person this run could capture at all.
 */
import {
  AgentVisibilityInputError,
  buildAgentBriefing,
  type AgentBriefingBuildInput,
  type AgentBriefingIndex,
  type VisibilitySanitizer,
} from "@shared/agent-visibility";
import type { Db } from "../db/types.js";
import {
  configuredVisibilityDetector,
  redactForStorage,
  VisibilityCaptureRefusal,
} from "./visibility-detector.js";

/** How much of a refusal is kept beside the send it explains. */
const DETAIL_MAX_LENGTH = 500;

export interface RecordAgentBriefingOptions {
  /**
   * Whether capture is switched on for this send. False records the send as a
   * marker: "there is no briefing because capture was off", which is what
   * stops a reader being told this code could not capture at all.
   */
  capture?: boolean;
  /** The detector; production reads the configured secrets from `process.env`. */
  sanitize?: VisibilitySanitizer;
  /** An already-scoped client, for tests and callers that hold one. */
  db?: Db;
}

export type RecordAgentBriefingOutcome =
  | { outcome: "recorded"; briefingId: number }
  /** A replay or a retry wrote the same send again. */
  | { outcome: "already_recorded" }
  /** A different briefing is stored under this identity and sequence; it was
   *  left alone. Content decides that, with the capture time left out: a
   *  re-executed step stamps a new time for the same send. */
  | { outcome: "conflict" }
  /** Capture was switched off when this send happened. */
  | { outcome: "capture_disabled" }
  /** The record was refused (malformed input, a sanitizer that misbehaved). */
  | { outcome: "refused"; reason: string }
  /** Nothing could be written at all. */
  | { outcome: "failed"; reason: string };

/**
 * One send, as a caller that has no briefing to build still knows it.
 *
 * Taken from the builder's own input rather than spelled out again, so the two
 * ways into this module cannot drift: a field the package adds to a send's
 * identity has to be answered on the skipped path too.
 */
export type AgentBriefingSendIdentity = Pick<
  AgentBriefingBuildInput["identity"],
  "runId" | "nodeId" | "attempt" | "activationScopeId" | "sequence" | "kind"
>;

function identityOf(input: AgentBriefingBuildInput): AgentBriefingSendIdentity {
  return {
    runId: input.identity.runId,
    nodeId: input.identity.nodeId,
    attempt: input.identity.attempt,
    activationScopeId: input.identity.activationScopeId,
    sequence: input.identity.sequence,
    kind: input.identity.kind,
  };
}

/** A refusal's own sentence, kept only where it can itself be stored. */
function safeDetail(message: string, sanitize: VisibilitySanitizer): string {
  try {
    return redactForStorage(message, sanitize).slice(0, DETAIL_MAX_LENGTH);
  } catch {
    return "the record was refused, and the reason could not be stored";
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function store(
  options: RecordAgentBriefingOptions,
  row: Parameters<
    typeof import("../db/repositories/agent-visibility.js").recordAgentBriefingRow
  >[1],
) {
  // Deferred, like every other write reached from a step body: the database
  // client may not load until a step actually runs.
  const repository = await import("../db/repositories/agent-visibility.js");
  return options.db
    ? repository.recordAgentBriefingRow(options.db, row)
    : repository.recordConnectedAgentBriefingRow(row);
}

/**
 * The run's durable facts, best effort and never in the way of an outcome.
 *
 * Written on every outcome this module can reach, because the row's existence
 * is what later says "this run's code could capture": a run whose write failed
 * has to read as capture lost, not as a run from before the feature. A replay
 * writes nothing, so the counts stay the counts of sends.
 */
async function note(
  options: RecordAgentBriefingOptions,
  identity: AgentBriefingSendIdentity,
  fact: "captured" | "disabled" | "skipped" | "failed" | "conflict",
): Promise<void> {
  try {
    const repository = await import("../db/repositories/agent-visibility.js");
    await (options.db
      ? repository.recordAgentBriefingRunFact(options.db, identity.runId, fact)
      : repository.recordConnectedAgentBriefingRunFact(identity.runId, fact));
  } catch (error) {
    await warn(identity, error, "agent_briefing_run_fact_failed");
  }
}

async function warn(
  identity: AgentBriefingSendIdentity,
  error: unknown,
  message: string,
): Promise<void> {
  const { logger } = await import("../infra/logger.js");
  logger.warn(
    {
      runId: identity.runId,
      nodeId: identity.nodeId,
      attempt: identity.attempt,
      sequence: identity.sequence,
      err: error instanceof Error ? error.message : String(error),
    },
    message,
  );
}

/**
 * The row that says a send happened and no briefing was kept, plus the run
 * fact that goes with it.
 *
 * THE ONLY PLACE THIS ROW IS BUILT. Capture used to build its own copy against
 * the repository, and the copy wrote no run fact on two of its outcomes, so a
 * run whose sends were all lost read back as a run from before the feature.
 * No text is stored on this path, so nobody is shown a briefing that is
 * nothing but `[REDACTED]`.
 */
async function marker(
  options: RecordAgentBriefingOptions,
  identity: AgentBriefingSendIdentity,
  written: {
    capture: "capture_disabled" | "capture_skipped";
    detail: string | null;
    capturedAt: Date;
  },
): Promise<"recorded" | "already_recorded" | "conflict"> {
  const stored = await store(options, {
    runId: identity.runId,
    nodeId: identity.nodeId,
    attempt: identity.attempt,
    activationScopeId: identity.activationScopeId,
    sequence: identity.sequence,
    kind: identity.kind,
    capture: written.capture,
    index: null,
    contentSha256: null,
    texts: [],
    bytes: 0,
    detail: written.detail,
    capturedAt: written.capturedAt,
  });
  if (stored.outcome === "conflict") {
    await note(options, identity, "conflict");
    return "conflict";
  }
  // A REPLAY BUMPS NOTHING. The same send arriving again is not a second send.
  if (stored.outcome === "already_recorded") return "already_recorded";
  await note(options, identity, written.capture === "capture_disabled" ? "disabled" : "skipped");
  return "recorded";
}

/**
 * Record one send, or say why there is nothing to record.
 *
 * The briefing is built here, with the detector, so no configured secret
 * reaches a stored byte and the stored text is what MCP serves unchanged.
 */
export async function recordAgentBriefing(
  input: AgentBriefingBuildInput,
  options: RecordAgentBriefingOptions = {},
): Promise<RecordAgentBriefingOutcome> {
  const identity = identityOf(input);
  const capturedAt = new Date(input.identity.capturedAt);
  const kind = input.identity.kind;
  try {
    if (options.capture === false) {
      const written = await marker(options, identity, {
        capture: "capture_disabled",
        detail: null,
        capturedAt,
      });
      return written === "conflict" ? { outcome: "conflict" } : { outcome: "capture_disabled" };
    }

    const sanitize = options.sanitize ?? configuredVisibilityDetector();
    let built: { index: AgentBriefingIndex; texts: { sha256: string; text: string }[] };
    try {
      built = await buildAgentBriefing(input, { sanitize });
    } catch (error) {
      // The record was refused, and the send still happened: a marker says so,
      // so a reader is told "not recorded" rather than "this code could not
      // capture". NO TEXT IS STORED on this path, so nobody is shown a
      // briefing whose every section reads `[REDACTED]`.
      const refused =
        error instanceof AgentVisibilityInputError || error instanceof VisibilityCaptureRefusal;
      if (!refused) throw error;
      const reason = safeDetail(error.message, sanitize);
      await warn(identity, error, "agent_briefing_refused");
      const written = await marker(options, identity, {
        capture: "capture_skipped",
        detail: reason,
        capturedAt,
      });
      return written === "conflict" ? { outcome: "conflict" } : { outcome: "refused", reason };
    }

    const encoder = new TextEncoder();
    const serialized = JSON.stringify(built.index);
    // The identity of the CONTENT, with the capture time left out: a step that
    // runs again stamps a new time for the same send, and comparing the whole
    // index would call that a second, different briefing.
    const { capturedAt: _stamped, ...timeless } = built.index.identity;
    const texts = built.texts.map((entry) => ({
      sha256: entry.sha256,
      text: entry.text,
      bytes: encoder.encode(entry.text).length,
    }));
    const result = await store(options, {
      ...identity,
      capture: "captured",
      index: built.index,
      contentSha256: await sha256Hex(JSON.stringify({ ...built.index, identity: timeless })),
      texts,
      bytes: encoder.encode(serialized).length + texts.reduce((total, entry) => total + entry.bytes, 0),
      detail: null,
      capturedAt,
    });
    if (result.outcome === "recorded") {
      await note(options, identity, "captured");
      return { outcome: "recorded", briefingId: result.briefingId };
    }
    // A REPLAY BUMPS NOTHING. The same send arriving again is not a second
    // send, and a run whose step replayed all weekend would otherwise read as
    // a run that captured hundreds of times.
    if (result.outcome === "already_recorded") return { outcome: "already_recorded" };
    await note(options, identity, "conflict");
    await warn(
      identity,
      new Error(
        `a ${result.stored.kind} ${result.stored.capture} briefing is already stored under this identity; this one is ${kind} captured`,
      ),
      "agent_briefing_identity_conflict",
    );
    return { outcome: "conflict" };
  } catch (error) {
    await warn(identity, error, "agent_briefing_write_failed");
    // The send happened and nothing kept it: the run says so even here, so a
    // reader meets "capture failed" instead of "this run predates capture".
    await note(options, identity, "failed");
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Record that a send took its place in the order and nothing went out under it.
 *
 * The same marker row and the same run fact a refusal writes, because it IS the
 * same fact about the same table: a send step can fail before it launches
 * anything, and the sequence number is already spent by then. Without the row a
 * reader meets sequences 1 and 3 with a silent 2 and has to guess what became
 * of the middle one.
 *
 * The reason is redacted and bounded exactly like a refusal's, because it is
 * stored text like any other: a caller that builds it from an error message has
 * no way of knowing what the message picked up.
 */
export async function recordSkippedAgentBriefing(
  identity: AgentBriefingSendIdentity,
  skip: { reason: string; capturedAt: Date },
  options: RecordAgentBriefingOptions = {},
): Promise<RecordAgentBriefingOutcome> {
  // A send made while capture was off is the same row whether it went out or
  // not: a run that started with capture off says so for every one of its
  // sends, and no reason is kept for a send nobody asked to keep.
  const disabled = options.capture === false;
  try {
    const reason = safeDetail(skip.reason, options.sanitize ?? configuredVisibilityDetector());
    const written = await marker(options, identity, {
      capture: disabled ? "capture_disabled" : "capture_skipped",
      detail: disabled ? null : reason,
      capturedAt: skip.capturedAt,
    });
    if (written === "conflict") return { outcome: "conflict" };
    if (written === "already_recorded") return { outcome: "already_recorded" };
    return disabled ? { outcome: "capture_disabled" } : { outcome: "refused", reason };
  } catch (error) {
    await warn(identity, error, "agent_briefing_skip_failed");
    await note(options, identity, "failed");
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Say this run's code could capture and this send was lost, where no outcome
 * could be written at all.
 *
 * The caller stopped waiting, or could not reach this module, so the row that
 * would have carried the outcome does not exist. The run fact still has to, or
 * the run reads back as one from before the feature: a lie told exactly when
 * something else has already gone wrong.
 */
export async function noteAgentBriefingLoss(
  identity: AgentBriefingSendIdentity,
  options: RecordAgentBriefingOptions = {},
): Promise<void> {
  await note(options, identity, "failed");
}
