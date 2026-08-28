import { getRun } from "workflow/api";
import { env } from "../../env.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type IssueTrackerMoveTarget,
} from "../adapters/issue-tracker/types.js";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
} from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import {
  cancelRunDetailed,
  cancelSubjectRunDetailed,
  type CancelRunResult,
} from "./cancel-run.js";
import { logger } from "./logger.js";
import { ticketSubjectKey } from "./subject-key.js";
import { withdrawTicketFromAiForRun } from "./ticket-transition.js";
import {
  markRunFailedByWatchdog,
  WATCHDOG_FAILURE_REASON_PREFIX,
} from "./telemetry/run-telemetry.js";

/**
 * A step still "running" this long after it was created has outlived every
 * invocation the platform allows. The deployed step function's maxDuration is
 * "max" (800 s on Pro, 900 s on Enterprise), and when the invocation is killed
 * at that ceiling the queue redelivers the same message after its visibility
 * timeout (about five minutes), which starts a new attempt of the SAME step:
 * the step's createdAt does not move. Twenty minutes is therefore past one
 * full kill-and-redeliver cycle, and a healthy step never gets anywhere near
 * it (poll ticks sleep 30 s; nothing else may legally run that long).
 *
 * Anchoring on the newest step's createdAt, not on "any recent event", is
 * deliberate: the redelivery writes a fresh step_started every cycle, so an
 * event-recency rule would see activity in a run whose engine is dead.
 */
export const STALLED_STEP_AFTER_MS = 20 * 60_000;

export interface StalledStep {
  stepId: string;
  stepName: string;
  attempt: number;
  createdAt: Date;
}

function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The newest step of the run, when it is "running" and older than
 * STALLED_STEP_AFTER_MS. A run waiting on a hook or between steps has no
 * running step and is never reported: only a handler the event log believes
 * is executing, past the point where any handler could be, counts.
 */
export async function findStalledStep(
  runId: string,
  now: number = Date.now(),
): Promise<StalledStep | null> {
  const { getWorld } = await import("workflow/runtime");
  const page = await getWorld().steps.list({
    runId,
    resolveData: "none",
    pagination: { limit: 1, sortOrder: "desc" },
  });
  const newest = page.data[0];
  if (!newest || newest.status !== "running") return null;
  if (
    typeof newest.stepId !== "string" ||
    typeof newest.stepName !== "string" ||
    typeof newest.attempt !== "number" ||
    !Number.isFinite(newest.attempt)
  ) {
    return null;
  }
  const createdAt = toMs(newest.createdAt);
  if (createdAt === null || now - createdAt <= STALLED_STEP_AFTER_MS) return null;
  return {
    stepId: newest.stepId,
    stepName: newest.stepName,
    attempt: newest.attempt,
    createdAt: new Date(createdAt),
  };
}

export function stalledRunReason(stalled: StalledStep, now: number): string {
  const minutes = Math.max(1, Math.round((now - stalled.createdAt.getTime()) / 60_000));
  const name = stalled.stepName.split("//").pop() || stalled.stepName;
  return (
    `${WATCHDOG_FAILURE_REASON_PREFIX} step "${name}" has been running for ${minutes} minutes ` +
    `(attempt ${stalled.attempt}) with no later step recorded, longer than any ` +
    `function invocation can live. The stall watchdog cancelled the run.`
  );
}

/**
 * A Backlog target may be used only after a live Jira read. The poll route's
 * aiColumnTickets set is a snapshot taken before this reconciliation pass; a
 * workflow can have moved the ticket to Review/Done in the meantime. In that
 * case cancellation preserves the selected destination. Confirmed absence is
 * also safe; every other unavailable live read fails closed.
 */
type TicketMoveDecision =
  | { safe: true; moveTarget?: IssueTrackerMoveTarget }
  | { safe: false };

async function safeTicketMoveTarget(input: {
  ticketKey: string;
  issueTracker?: IssueTrackerAdapter;
  moveTarget?: IssueTrackerMoveTarget;
  context: { subjectKey: string; runId: string };
}): Promise<TicketMoveDecision> {
  if (!input.issueTracker) {
    logger.warn(input.context, "stall_watchdog_ticket_tracker_missing");
    return { safe: false };
  }
  if (!input.moveTarget) {
    logger.warn(
      { ...input.context, ticketKey: input.ticketKey },
      "stall_watchdog_ticket_move_target_missing",
    );
    return { safe: false };
  }
  try {
    const ticket = await input.issueTracker.fetchTicket(input.ticketKey);
    const inAi =
      ticket.trackerStatus.trim().toLowerCase() === env.COLUMN_AI.trim().toLowerCase();
    if (!inAi) {
      logger.info(
        {
          ...input.context,
          ticketKey: input.ticketKey,
          liveStatus: ticket.trackerStatus,
        },
        "stall_watchdog_preserved_ticket_destination",
      );
    }
    // Keep the safe target available even when this first read is outside AI.
    // The exact cancelling-owner fence reads Jira again: it preserves an
    // unchanged Review/Done destination, but can still evict Review -> AI.
    return { safe: true, moveTarget: input.moveTarget };
  } catch (error) {
    if (isIssueTrackerNotFound(error)) {
      logger.info(
        { ...input.context, ticketKey: input.ticketKey },
        "stall_watchdog_ticket_absent",
      );
      // The ticket cannot still be in AI, but preserve the configured target
      // for the exact cancelling-owner fence. That fence must still verify
      // ownership before allowing cancellation to release the claim.
      return { safe: true, moveTarget: input.moveTarget };
    }
    logger.warn(
      {
        ...input.context,
        ticketKey: input.ticketKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "stall_watchdog_ticket_state_unreachable",
    );
    return { safe: false };
  }
}

function isIssueTrackerNotFound(error: unknown): boolean {
  if (error instanceof IssueTrackerNotFoundError) return true;
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "NOT_FOUND";
}

/**
 * Settles a bound run whose engine is dead: the Workflow run still reports
 * "running", but its newest step has been "running" longer than any invocation
 * can live (see STALLED_STEP_AFTER_MS). Nothing else ever ends such a run: the
 * workflow body never reaches its own finally, the claim stays, the ticket is
 * undispatchable, and the dashboard shows a healthy run (UP-4765, 2026-08-21).
 *
 * Order of operations: a Jira ticket is live-read first so a failed lookup can
 * never release a claim while the ticket remains in AI; then the "failed"
 * status and reason are written before cancellation so the outcome is durable
 * whatever the cancel confirms. Cancellation uses the same machinery the
 * reconciler uses for orphans (moving an AI ticket to Backlog, so discovery
 * does not re-dispatch it). Returns true when the run was torn down, in which
 * case the caller must not treat the entry as healthy any further this tick.
 */
export async function reconcileStalledRun(input: {
  entry: ActiveRunEntry & { runId: string };
  runRegistry: RunRegistryAdapter;
  db: Db;
  issueTracker?: IssueTrackerAdapter;
  moveTarget?: IssueTrackerMoveTarget;
  onSubjectReleased?: (subjectKey: string) => Promise<void> | void;
  now?: number;
}): Promise<boolean> {
  const { entry, runRegistry, db } = input;
  const now = input.now ?? Date.now();
  const context = { subjectKey: entry.subjectKey, runId: entry.runId };

  // Only a bound claim represents a run the reconciler owns and can safely
  // settle. Reservations/parking are handled by their own recovery paths.
  if (entry.state !== "bound") return false;

  let status: string;
  try {
    status = await getRun(entry.runId).status;
  } catch (error) {
    logger.warn(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      "stall_watchdog_run_status_unreachable",
    );
    return false;
  }
  if (status !== "running") return false;

  let stalled: StalledStep | null;
  try {
    stalled = await findStalledStep(entry.runId, now);
  } catch (error) {
    logger.warn(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      "stall_watchdog_steps_unreachable",
    );
    return false;
  }
  if (!stalled) return false;

  const reason = stalledRunReason(stalled, now);
  logger.warn(
    {
      ...context,
      stepId: stalled.stepId,
      stepName: stalled.stepName,
      attempt: stalled.attempt,
      stepCreatedAt: stalled.createdAt.toISOString(),
      stalledForMs: now - stalled.createdAt.getTime(),
    },
    "stall_watchdog_detected_dead_engine",
  );

  const target = { ownerToken: entry.ownerToken, runId: entry.runId };
  const ticketKey = entry.ticketKey;
  const followsJiraTicket =
    ticketKey !== null && entry.subjectKey === ticketSubjectKey("jira", ticketKey);
  let moveTarget = input.moveTarget;
  if (followsJiraTicket) {
    const decision = await safeTicketMoveTarget({
      ticketKey,
      issueTracker: input.issueTracker,
      moveTarget: input.moveTarget,
      context,
    });
    if (!decision.safe) return false;
    moveTarget = decision.moveTarget;
  }

  let statusPersisted: boolean;
  try {
    statusPersisted = await markRunFailedByWatchdog(db, entry.runId, reason);
  } catch (error) {
    logger.warn(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      "stall_watchdog_status_write_failed",
    );
    return false;
  }
  if (!statusPersisted) {
    logger.warn(context, "stall_watchdog_status_write_unconfirmed");
    return false;
  }

  const result: CancelRunResult =
    followsJiraTicket
      ? await cancelRunDetailed(
          ticketKey,
          target,
          runRegistry,
          input.issueTracker,
          moveTarget,
          input.onSubjectReleased,
          reason,
          async (owner) => {
            await withdrawTicketFromAiForRun({
              db,
              issueTracker: input.issueTracker!,
              ticketKey,
              aiColumn: env.COLUMN_AI,
              target: moveTarget,
              owner,
              requiredOwnerState: "cancelling",
            });
          },
        )
      : await cancelSubjectRunDetailed(
          entry.subjectKey,
          target,
          runRegistry,
          input.onSubjectReleased,
          reason,
        );
  if (!result.cancelled && !result.tornDown) {
    logger.warn(context, "stall_watchdog_cancel_unconfirmed");
    return false;
  }
  logger.warn(
    {
      ...context,
      released: result.released,
      alreadyTerminal: result.alreadyTerminal === true,
    },
    "stall_watchdog_cancelled_stalled_run",
  );
  return true;
}
