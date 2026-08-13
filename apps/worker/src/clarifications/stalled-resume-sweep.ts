import { getHookByToken } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { retryAnsweredResume } from "./answered-resume.js";
import { listStalledAnsweredClarifications } from "./hook-store.js";
import { retireParkedRun } from "./retire-park.js";

/**
 * How stale a recorded answer has to be before this pass touches it. The
 * dashboard route resumes without taking the resume claim, so a very fresh answer
 * may still be in flight in another invocation and must be left alone.
 */
export const RESUME_RETRY_GRACE_MS = 60_000;

/**
 * When redelivering stops being worth it. Retries run once a minute, so half an
 * hour of them means the resume is not going to land, and the park is costing a
 * concurrency slot the whole time. Well short of the seven day hook expiry, which
 * is the only thing that used to end this state.
 */
export const RESUME_GIVE_UP_MS = 30 * 60_000;

/**
 * Parks handled per pass. Every one of them costs a Workflow call and a tracker
 * read, and the pass shares its invocation with the rest of the poll.
 */
const MAX_ATTEMPTS_PER_PASS = 3;

export interface StalledResumeSweepResult {
  /** Parks this pass tried to move on. */
  attempted: number;
  /** Parks whose run is awake again. */
  resumed: number;
  /** Parks given up on, so their concurrency slot is free again. */
  retired: number;
}

/**
 * Redeliver answers whose resume never landed, and end the parks where it never
 * will.
 *
 * An answer is recorded before the hook is resumed, so a failure in between
 * leaves a run that is answered and still suspended. Until now only two things
 * reached that state: a person clicking retry in the dashboard, and the Jira
 * comment path, which the poll only calls for tickets sitting in the AI column.
 * That left two parks with no way back at all: one whose ticket is not in that
 * column (moved, or deleted), and a ticketless pull request park, which no
 * comment and no column move can ever reach. Both keep their bound claim, so both
 * hold one of MAX_CONCURRENT_AGENTS slots until the seven day expiry.
 *
 * The retry itself is not reimplemented here: it goes through the same
 * claim-and-redeliver used by the comment path, so two callers can never resume
 * one run twice.
 *
 * Giving up needs positive evidence, which is the hook: if it still exists the
 * resume provably never committed, and only then may the park be retired. A
 * consumed hook means the run is awake and only its marker was lost, so that case
 * falls through to the retry, which converges the marker instead of ending a live
 * run.
 *
 * Deliberate asymmetry with the deleted-ticket sweep next door: the redelivery
 * fetches the ticket, so an answered park whose ticket reads 404 is retired on a
 * single reading (as `ticket_gone`) instead of waiting out that sweep's
 * confirmation window. Kept, for two reasons: it is the same single-404 posture
 * the reconciler already takes for every unparked run, and the retirement it
 * performs supersedes the question without cancelling anything, so the claim is
 * released by the ordinary orphan cascade rather than by a verdict made here. The
 * cost of being wrong is one answer that has to be given again, not a killed run.
 */
export async function retryStalledResumes(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  issueTracker: IssueTrackerAdapter;
}): Promise<StalledResumeSweepResult> {
  const { db, runRegistry, issueTracker } = input;
  const result: StalledResumeSweepResult = { attempted: 0, resumed: 0, retired: 0 };

  const candidates = await listStalledAnsweredClarifications(
    db,
    new Date(Date.now() - RESUME_RETRY_GRACE_MS),
  );

  for (const row of candidates.slice(0, MAX_ATTEMPTS_PER_PASS)) {
    result.attempted++;
    const answeredAt = row.answeredAt?.getTime() ?? Date.now();

    if (Date.now() - answeredAt >= RESUME_GIVE_UP_MS) {
      const hook = await probeHook(row.hookToken);
      if (hook === "unknown") continue;
      if (hook === "live") {
        const cancellation = await retireParkedRun({
          db,
          runRegistry,
          runId: row.runId,
          cause: { kind: "resume_undeliverable" },
        });
        if (cancellation.outcome !== "unconfirmed") result.retired++;
        continue;
      }
    }

    const outcome = await retryAnsweredResume({ db, row, issueTracker });
    if (outcome.status === "resumed") result.resumed++;
    logger.info(
      {
        ticketKey: row.ticketKey,
        runId: row.runId,
        resumeStatus: outcome.status,
      },
      "stalled_resume_retried",
    );
  }

  return result;
}

/**
 * Established exactly as answer-core establishes it after a failed resume: the
 * hook is the record of a resume that never committed, and only an explicit
 * not-found result proves it did. Anything else is a transport problem and no
 * evidence either way.
 */
async function probeHook(token: string): Promise<"live" | "consumed" | "unknown"> {
  try {
    return (await getHookByToken(token)) === null ? "consumed" : "live";
  } catch (error) {
    if (HookNotFoundError.is(error)) return "consumed";
    logger.warn(
      { error: (error as Error).message },
      "stalled_resume_hook_probe_failed",
    );
    return "unknown";
  }
}
