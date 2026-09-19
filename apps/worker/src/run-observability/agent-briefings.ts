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

function identityOf(input: AgentBriefingBuildInput) {
  return {
    runId: input.identity.runId,
    nodeId: input.identity.nodeId,
    attempt: input.identity.attempt,
    activationScopeId: input.identity.activationScopeId,
    sequence: input.identity.sequence,
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
  input: AgentBriefingBuildInput,
  fact: "captured" | "disabled" | "skipped" | "failed" | "conflict",
): Promise<void> {
  try {
    const repository = await import("../db/repositories/agent-visibility.js");
    await (options.db
      ? repository.recordAgentBriefingRunFact(options.db, input.identity.runId, fact)
      : repository.recordConnectedAgentBriefingRunFact(input.identity.runId, fact));
  } catch (error) {
    await warn(input, error, "agent_briefing_run_fact_failed");
  }
}

async function warn(
  input: AgentBriefingBuildInput,
  error: unknown,
  message: string,
): Promise<void> {
  const { logger } = await import("../infra/logger.js");
  logger.warn(
    {
      runId: input.identity.runId,
      nodeId: input.identity.nodeId,
      attempt: input.identity.attempt,
      sequence: input.identity.sequence,
      err: error instanceof Error ? error.message : String(error),
    },
    message,
  );
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
      const marker = await store(options, {
        ...identity,
        kind,
        capture: "capture_disabled",
        index: null,
        contentSha256: null,
        texts: [],
        bytes: 0,
        detail: null,
        capturedAt,
      });
      if (marker.outcome === "conflict") {
        await note(options, input, "conflict");
        return { outcome: "conflict" };
      }
      if (marker.outcome === "recorded") await note(options, input, "disabled");
      return { outcome: "capture_disabled" };
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
      await warn(input, error, "agent_briefing_refused");
      const marker = await store(options, {
        ...identity,
        kind,
        capture: "capture_skipped",
        index: null,
        contentSha256: null,
        texts: [],
        bytes: 0,
        detail: reason,
        capturedAt,
      });
      if (marker.outcome === "conflict") {
        await note(options, input, "conflict");
        return { outcome: "conflict" };
      }
      if (marker.outcome === "recorded") await note(options, input, "skipped");
      return { outcome: "refused", reason };
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
      kind,
      capture: "captured",
      index: built.index,
      contentSha256: await sha256Hex(JSON.stringify({ ...built.index, identity: timeless })),
      texts,
      bytes: encoder.encode(serialized).length + texts.reduce((total, entry) => total + entry.bytes, 0),
      detail: null,
      capturedAt,
    });
    if (result.outcome === "recorded") {
      await note(options, input, "captured");
      return { outcome: "recorded", briefingId: result.briefingId };
    }
    // A REPLAY BUMPS NOTHING. The same send arriving again is not a second
    // send, and a run whose step replayed all weekend would otherwise read as
    // a run that captured hundreds of times.
    if (result.outcome === "already_recorded") return { outcome: "already_recorded" };
    await note(options, input, "conflict");
    await warn(
      input,
      new Error(
        `a ${result.stored.kind} ${result.stored.capture} briefing is already stored under this identity; this one is ${kind} captured`,
      ),
      "agent_briefing_identity_conflict",
    );
    return { outcome: "conflict" };
  } catch (error) {
    await warn(input, error, "agent_briefing_write_failed");
    // The send happened and nothing kept it: the run says so even here, so a
    // reader meets "capture failed" instead of "this run predates capture".
    await note(options, input, "failed");
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
