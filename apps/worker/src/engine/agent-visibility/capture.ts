/**
 * Recording one send, from INSIDE the step that sends it.
 *
 * A FAILURE HERE NEVER FAILS A RUN. Every send step keeps `maxRetries = 0`, so
 * a throw from this module would kill an agent that is about to start; and the
 * run is worth more than the record of it. Everything is caught, everything is
 * logged with the run and the attempt so a loss can be found rather than
 * merely counted, and nothing is rethrown. Modelled on
 * `engine/work-scope/apply-plans.ts`, including the deferred imports: a step
 * body reaches this file through a dynamic import, and the database client may
 * not load until a step actually runs.
 *
 * It is also bounded in TIME, not only in exceptions. The deployed step
 * function is killed at 800 seconds, and an insert that hangs would spend that
 * ceiling on the record instead of on the work, so the write races a timeout
 * and the step returns either way.
 *
 * The section texts are sliced out of the prompt and the system prompt the
 * step already holds; the plan (`plan.ts`) carried only the ranges.
 */
import type { AgentBriefingBuildInput, VisibilitySanitizer } from "@shared/agent-visibility";
import type { Db } from "../../db/types.js";
import type { RecordAgentBriefingOutcome } from "../../run-observability/agent-briefings.js";
import type { AgentBriefingCapture, BriefingTextSource } from "./plan.js";

/**
 * What became of one send's record. Returned rather than swallowed so a test
 * can see the difference between "stored" and "quietly refused": the builder
 * refuses a section its parts do not reproduce, and a refusal that nothing
 * observed would turn every production briefing into an empty marker with
 * nothing red anywhere.
 */
/**
 * NO PRODUCTION CALLER READS THIS. It exists so a test can tell "stored" from
 * "quietly refused": every failure here is caught and logged by design, so
 * without a returned outcome a systematic refusal would look exactly like a
 * working feature from the outside.
 */
export type AgentBriefingCaptureOutcome =
  | RecordAgentBriefingOutcome
  /** No briefing travelled with this send: a journal from before capture. */
  | { outcome: "not_requested" }
  /** The record did not finish in time; the step went on without it. */
  | { outcome: "timed_out" }
  /** Capture itself could not be reached, so it could not even fail properly. */
  | { outcome: "unavailable"; reason: string };

/**
 * How long the record may take before the step stops waiting for it.
 *
 * Far below the step's own 800 second ceiling, and far above a healthy insert
 * of half a megabyte: a write that has not landed in this long is not slow,
 * it is stuck, and waiting for it costs the run the agent.
 */
export const BRIEFING_CAPTURE_TIMEOUT_MS = 15_000;

/** The same, for the one-line fact that says this run could capture at all. */
const RUN_FACT_TIMEOUT_MS = 3_000;

export interface CaptureAgentBriefingOptions {
  /** An already-scoped client, for tests. Production uses the connected one. */
  db?: Db;
  /** Overrides the configured detector, for tests. */
  sanitize?: VisibilitySanitizer;
  timeoutMs?: number;
}

/** The texts the step already holds, which the plan's ranges point into. */
export interface CaptureTexts {
  prompt: string;
  system?: string | undefined;
  /** The wrapper script as written into the sandbox, or null for an in-process
   *  call. It carries no credentials: those are sourced from a separate file. */
  wrapperScript?: string | null;
}

/**
 * Record what this send gave the model.
 *
 * `undefined` is the shape of a journal written before this argument existed:
 * such a send simply has no briefing, and the read model already knows that
 * reason. It is not an error and is not logged, because it is the expected
 * state of every run that was in flight across the deploy.
 */
export async function captureAgentBriefing(
  capture: AgentBriefingCapture | null | undefined,
  texts: CaptureTexts,
  options: CaptureAgentBriefingOptions = {},
): Promise<AgentBriefingCaptureOutcome> {
  if (!capture) return { outcome: "not_requested" };
  const timeoutMs = options.timeoutMs ?? BRIEFING_CAPTURE_TIMEOUT_MS;
  try {
    const input = buildInput(capture, texts);
    const { recordAgentBriefing } = await import("../../run-observability/agent-briefings.js");
    const outcome = await within(
      timeoutMs,
      recordAgentBriefing(input, {
        capture: capture.enabled,
        ...(options.db ? { db: options.db } : {}),
        ...(options.sanitize ? { sanitize: options.sanitize } : {}),
      }),
    );
    if (outcome !== TIMED_OUT) return outcome;
    await warn(capture, `the record did not finish within ${timeoutMs} ms`, "agent_briefing_capture_timeout");
    // The run still has to say its code could capture, or a reader meets
    // "this run predates capture" for a run that tried and was too slow.
    await noteFailure(capture, options, timeoutMs);
    return { outcome: "timed_out" };
  } catch (error) {
    await warn(capture, error, "agent_briefing_capture_failed");
    await noteFailure(capture, options, timeoutMs);
    return { outcome: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Turn the plan plus the texts the step holds into the builder's input. */
export function buildInput(
  capture: AgentBriefingCapture,
  texts: CaptureTexts,
  now: Date = new Date(),
): AgentBriefingBuildInput {
  // A missing source is a mismatch between the plan and the step, not an empty
  // section: storing "" would show a person a system prompt that was never
  // there. The unknown-source case is caught the same way.
  const sources: Partial<Record<BriefingTextSource, string>> = {
    prompt: texts.prompt,
    ...(texts.system === undefined ? {} : { system: texts.system }),
  };
  return {
    identity: { ...capture.identity, capturedAt: now.toISOString() },
    harness: {
      ...capture.harness,
      ...(texts.wrapperScript === undefined ? {} : { wrapperScript: texts.wrapperScript }),
    },
    sections: capture.sections.map((section) => {
      const source = sources[section.text.source];
      if (source === undefined) {
        throw new Error(
          `The briefing points a ${section.kind} section at "${section.text.source}", which this send did not carry.`,
        );
      }
      const text = source.slice(section.text.start, section.text.end);
      return {
        kind: section.kind,
        title: section.title,
        ...(section.provenance ? { provenance: section.provenance } : {}),
        text,
        ...(section.parts ? { parts: slicedParts(section.parts, text) } : {}),
      };
    }),
    ...(capture.repositoryContext === undefined
      ? {}
      : { repositoryContext: capture.repositoryContext }),
    ...(capture.unresolvedSources ? { unresolvedSources: capture.unresolvedSources } : {}),
  };
}

function slicedParts(
  parts: NonNullable<AgentBriefingCapture["sections"][number]["parts"]>,
  text: string,
): NonNullable<AgentBriefingBuildInput["sections"][number]["parts"]> {
  let offset = 0;
  return parts.map((part) => {
    const start = offset;
    offset += part.length;
    return {
      id: part.id,
      title: part.title,
      origin: part.origin,
      content: text.slice(start, offset),
      ...(part.cut ? { cut: part.cut } : {}),
      ...(part.withheld ? { withheld: part.withheld } : {}),
    };
  });
}

const TIMED_OUT = Symbol("timed out");

async function within<T>(ms: number, work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Say the run's code could capture and this send was lost.
 *
 * Its own short timeout, and never longer than the briefing itself was given:
 * the reason the briefing failed is usually the reason this would hang, and
 * the step is not allowed to spend a second full wait on it.
 */
async function noteFailure(
  capture: AgentBriefingCapture,
  options: CaptureAgentBriefingOptions,
  budgetMs: number,
): Promise<void> {
  try {
    const { noteAgentBriefingLoss } = await import("../../run-observability/agent-briefings.js");
    await within(
      Math.min(RUN_FACT_TIMEOUT_MS, budgetMs),
      noteAgentBriefingLoss(capture.identity, options.db ? { db: options.db } : {}),
    );
  } catch (error) {
    await warn(capture, error, "agent_briefing_run_fact_failed");
  }
}

async function warn(capture: AgentBriefingCapture, error: unknown, message: string): Promise<void> {
  try {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      {
        runId: capture.identity.runId,
        nodeId: capture.identity.nodeId,
        attempt: capture.identity.attempt,
        sequence: capture.identity.sequence,
        err: error instanceof Error ? error.message : String(error),
      },
      message,
    );
  } catch {
    // A step that never throws is only safe while even its logging cannot: the
    // deferred import inside this catch can itself fail cold.
  }
}

/**
 * Record that this place in the order exists and nothing went out under it.
 *
 * A send step can fail before it launches anything (the wrapper could not be
 * made executable), and the sequence number is already spent by then. Without
 * this the reader meets sequences 1 and 3 with a silent 2 and has to guess
 * what happened to it, which is a classification made in a reader's head.
 *
 * No text is stored on this path, so it is the same record whether capture is
 * on or off; a run that started with capture off still says so, because that
 * is what every other send of that run says.
 *
 * THE ROW ITSELF IS NOT BUILT HERE. `run-observability/agent-briefings.ts`
 * owns every write to this table, including this one: the copy that used to
 * live here wrote no run fact when the write timed out or met a conflict, and
 * a run whose sends all ended that way then read back as a run from before the
 * feature existed.
 */
export async function captureSkippedSend(
  capture: AgentBriefingCapture | null | undefined,
  reason: string,
  options: CaptureAgentBriefingOptions = {},
): Promise<AgentBriefingCaptureOutcome> {
  if (!capture) return { outcome: "not_requested" };
  const timeoutMs = options.timeoutMs ?? BRIEFING_CAPTURE_TIMEOUT_MS;
  try {
    const { recordSkippedAgentBriefing } = await import("../../run-observability/agent-briefings.js");
    const outcome = await within(
      timeoutMs,
      recordSkippedAgentBriefing(
        capture.identity,
        { reason, capturedAt: new Date() },
        {
          capture: capture.enabled,
          ...(options.db ? { db: options.db } : {}),
          ...(options.sanitize ? { sanitize: options.sanitize } : {}),
        },
      ),
    );
    if (outcome !== TIMED_OUT) return outcome;
    await warn(capture, `the record did not finish within ${timeoutMs} ms`, "agent_briefing_skip_timeout");
    // Same reason as above: the run has to say its code could capture, or this
    // send disappears into "this run predates capture".
    await noteFailure(capture, options, timeoutMs);
    return { outcome: "timed_out" };
  } catch (error) {
    await warn(capture, error, "agent_briefing_skip_failed");
    await noteFailure(capture, options, timeoutMs);
    return { outcome: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
