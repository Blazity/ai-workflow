import { getRun } from "workflow/api";
import { env } from "../../env.js";
import { isAiReviewDestination } from "./ai-review-destination.js";
import {
  decideAiReviewRun,
  PREMATURE_AI_REVIEW_CANCELLATION_REASON,
} from "./ai-review-transition.js";
import {
  cancelRunDetailed,
  cancelSubjectRunDetailed,
  type CancelRunResult,
} from "./cancel-run.js";
import { logger } from "./logger.js";
import { stopSandboxesByIds } from "../sandbox/stop-ticket-sandboxes.js";
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
import { confirmWorkflowStepsDrained } from "./workflow-step-drain.js";
import { reconcileStartupWatchdog } from "./run-start-lifecycle.js";
import { ticketSubjectKey } from "./subject-key.js";
import { withdrawTicketFromAiForRun } from "./ticket-transition.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STALE_RESERVATION_MS = 5 * 60 * 1000;
const ORPHAN_GRACE_MS = 30 * 1000;

/**
 * A ticket-triggered run can reach a terminal Workflow status without any
 * node ever moving its ticket out of the AI column: a `terminate` node with
 * terminalStatus "done"/"skipped" (e.g. an injection screen's block path)
 * only posts a comment, on purpose - "the block owns the ticket status", not
 * the platform. Left alone, the claim below would simply be released while
 * the ticket stays in AI, and the very next poll's JQL discovery re-dispatches
 * the same ticket forever. This is the platform-level safety net: it does not
 * depend on the workflow author remembering update_ticket_status.
 */
const STUCK_TICKET_EVICTION_REASON =
  "Reconciler moved this ticket to Backlog: its most recent run ended without moving the ticket out of the AI column.";

type TicketCancellationReason = "orphaned_run" | "inflight_claim";
type TicketCancellationCallback = (
  ticketKey: string,
  reason: TicketCancellationReason,
) => Promise<void> | void;
type SubjectReleasedCallback = (subjectKey: string) => Promise<void> | void;

export async function reconcileRuns(
  aiColumnTickets: Set<string>,
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  onTicketCancelled?: TicketCancellationCallback,
  onSubjectReleased?: SubjectReleasedCallback,
  parkedSubjects?: ReadonlySet<string>,
  db?: Db,
  terminalReconciliationSubjects?: ReadonlySet<string>,
): Promise<{ cancelled: number; cleaned: number }> {
  let cancelled = 0;
  if (db) {
    try {
      const startup = await reconcileStartupWatchdog({
        db,
        runRegistry,
        onSubjectReleased,
      });
      cancelled += startup.cancelled;
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "startup_watchdog_reconciliation_failed",
      );
    }
  }
  const entries = await runRegistry.listAll();
  let cleaned = 0;

  for (const listedEntry of entries) {
    let entry = listedEntry;
    // Cancellation failures deliberately retain a dispatch-blocking closing
    // claim. Retry that durable intent before any parked/terminal/orphan logic;
    // a clarification tombstone may have made a previously parked subject
    // closing, and it must not be skipped by the old protection snapshot.
    if (entry.state === "cancelling") {
      const result = await retryCancellingClaim(
        entry,
        runRegistry,
        issueTracker,
        onSubjectReleased,
      );
      if (result.cancelled) {
        if (result.alreadyTerminal) {
          logger.info(
            { ticketKey: entry.ticketKey ?? "", runId: entry.runId },
            "reconcile_released_already_terminal_run",
          );
        } else {
          await notifyTicketCancelled(
            entry.ticketKey ?? "",
            entry.runId ? "orphaned_run" : "inflight_claim",
            entry.ticketKey ? onTicketCancelled : undefined,
          );
        }
        cancelled++;
      }
      continue;
    }

    if (entry.state === "parking") {
      const recovered = await recoverParkingClaim(entry, runRegistry);
      if (!recovered) continue;
      entry = recovered;
    }

    // A pending clarification suspends the same Workflow while its ticket is
    // parked outside AI. Do not mistake that deliberate wait for an orphan.
    if (parkedSubjects?.has(entry.subjectKey)) continue;

    // Once answered, that Workflow may keep running while the ticket remains
    // outside AI. Reconcile only terminal cleanup: cleanFinishedRun retains the
    // exact owner until the whole Workflow and every durable step have drained.
    if (terminalReconciliationSubjects?.has(entry.subjectKey)) {
      if (entry.runId) {
        cleaned += await cleanFinishedRun(
          { ...entry, runId: entry.runId },
          runRegistry,
          issueTracker,
          onSubjectReleased,
          db,
        );
      }
      continue;
    }

    if (entry.state === "reserved") {
      cleaned += await recoverStaleReservation(
        entry,
        runRegistry,
        issueTracker,
        onSubjectReleased,
        db,
      );
      continue;
    }
    if (!entry.runId) continue;
    const boundEntry = { ...entry, runId: entry.runId };

    const followsTicketColumn =
      (entry.kind === "ticket" || entry.kind === "manual_ticket") &&
      entry.ticketKey !== null;
    const ticketStillInAiColumn =
      followsTicketColumn && aiColumnTickets.has(entry.ticketKey as string);

    if (!followsTicketColumn) {
      cleaned += await cleanFinishedRun(
        boundEntry,
        runRegistry,
        issueTracker,
        onSubjectReleased,
        db,
      );
      continue;
    }

    if (ticketStillInAiColumn) {
      cleaned += entry.kind === "manual_ticket"
        ? await cleanFinishedManualTicket(
            boundEntry,
            runRegistry,
            issueTracker,
            onSubjectReleased,
            db,
          )
        : await cleanStuckTicketRun(
            boundEntry,
            entry.ticketKey as string,
            runRegistry,
            issueTracker,
            onSubjectReleased,
          );
      continue;
    }

    const ticketKey = entry.ticketKey as string;
    if (Date.now() - entry.createdAt < ORPHAN_GRACE_MS) {
      logger.info(
        { ticketKey, runId: entry.runId },
        "reconcile_skipped_fresh_orphan_in_grace",
      );
      continue;
    }
    const departure = await verifyTicketLeftAiColumn(ticketKey, issueTracker);
    if (!departure.left) continue;
    const reviewDestination =
      departure.trackerStatus !== null &&
      (await isAiReviewDestination({
        issueTracker: issueTracker!,
        ticketKey,
        statusName: departure.trackerStatus,
        statusId: departure.trackerStatusId,
      }));
    if (
      reviewDestination &&
      await shouldRetainFinalizingRunInAiReview(
        ticketKey,
        entry.runId,
        db,
      )
    ) {
      continue;
    }

    const cancellationResult = await cancelRunDetailed(
      ticketKey,
      entry.runId,
      runRegistry,
      issueTracker,
      undefined,
      onSubjectReleased,
      reviewDestination
        ? PREMATURE_AI_REVIEW_CANCELLATION_REASON
        : "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
    if (!cancellationResult.cancelled) {
      logger.warn({ ticketKey, runId: entry.runId }, "reconcile_orphan_cancel_unconfirmed");
      continue;
    }
    if (cancellationResult.alreadyTerminal) {
      logger.info(
        { ticketKey, runId: entry.runId },
        "reconcile_released_already_terminal_run",
      );
    } else {
      logger.info({ ticketKey, runId: entry.runId }, "reconcile_cancelled_orphaned_run");
      await notifyTicketCancelled(ticketKey, "orphaned_run", onTicketCancelled);
    }
    cancelled++;
  }

  const failedTickets = await runRegistry.listAllFailed();
  for (const { ticketKey, meta } of failedTickets) {
    if (aiColumnTickets.has(ticketKey)) continue;
    const failedAtMs = Date.parse(meta.failedAt);
    if (Number.isFinite(failedAtMs) && Date.now() - failedAtMs < ORPHAN_GRACE_MS) {
      logger.info(
        { ticketKey, failedAt: meta.failedAt },
        "reconcile_skipped_fresh_failed_marker_in_grace",
      );
      continue;
    }
    await runRegistry.clearFailedMark(ticketKey);
    logger.info({ ticketKey }, "reconcile_cleared_failed_mark");
  }

  return { cancelled, cleaned };
}

async function recoverParkingClaim(
  entry: ActiveRunEntry,
  runRegistry: RunRegistryAdapter,
): Promise<ActiveRunEntry | null> {
  if (!entry.runId) return null;
  try {
    const began = await runRegistry.beginParking(
      entry.subjectKey,
      entry.ownerToken,
      entry.runId,
    );
    if (!began) {
      const current = await runRegistry.get(entry.subjectKey);
      return isExactParkedClaim(current, entry) ? current : null;
    }
    await stopOwnedSandboxes(entry, runRegistry);
    const finished = await runRegistry.finishParking(
      entry.subjectKey,
      entry.ownerToken,
      entry.runId,
    );
    if (!finished) {
      const current = await runRegistry.get(entry.subjectKey);
      return isExactParkedClaim(current, entry) ? current : null;
    }
    return { ...entry, state: "parked", updatedAt: Date.now() };
  } catch (error) {
    logger.warn(
      {
        subjectKey: entry.subjectKey,
        runId: entry.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "reconcile_clarification_parking_unconfirmed",
    );
    return null;
  }
}

function isExactParkedClaim(
  current: ActiveRunEntry | null,
  expected: ActiveRunEntry,
): current is ActiveRunEntry {
  return (
    current?.subjectKey === expected.subjectKey &&
    current.ownerToken === expected.ownerToken &&
    current.runId === expected.runId &&
    current.state === "parked"
  );
}

async function retryCancellingClaim(
  entry: ActiveRunEntry,
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  onSubjectReleased?: SubjectReleasedCallback,
): Promise<CancelRunResult> {
  const target = { ownerToken: entry.ownerToken, runId: entry.runId };
  const reason = entry.runId
    ? "Orphaned run cancelled by reconciler: ticket no longer in the AI column"
    : "In-flight claim cancelled by reconciler: ticket left the AI column before a run was bound";
  // Cancel the subject this claim actually holds. Deriving one from the ticket
  // key was the same string while every run was ticket-keyed; a pull request run
  // carries a ticket key but claims a pull request subject, and cancelling the
  // ticket subject would cancel nothing and leave the claim closing forever.
  if (
    !entry.ticketKey ||
    entry.subjectKey !== ticketSubjectKey("jira", entry.ticketKey)
  ) {
    return cancelSubjectRunDetailed(
      entry.subjectKey,
      target,
      runRegistry,
      onSubjectReleased,
      reason,
    );
  }

  const inAiColumn = await readLiveTicketInAiColumn(entry.ticketKey, issueTracker);
  if (inAiColumn === null) {
    logger.warn(
      { ticketKey: entry.ticketKey, runId: entry.runId },
      "reconcile_closing_ticket_state_unconfirmed",
    );
    return { cancelled: false, released: false };
  }
  const backlogTarget = env.JIRA_BACKLOG_TRANSITION_ID
    ? { name: env.COLUMN_BACKLOG, transitionId: env.JIRA_BACKLOG_TRANSITION_ID }
    : env.COLUMN_BACKLOG;
  return cancelRunDetailed(
    entry.ticketKey,
    target,
    runRegistry,
    issueTracker,
    inAiColumn ? backlogTarget : undefined,
    onSubjectReleased,
    reason,
  );
}

async function readLiveTicketInAiColumn(
  ticketKey: string,
  issueTracker?: IssueTrackerAdapter,
): Promise<boolean | null> {
  if (!issueTracker) return null;
  try {
    const ticket = await issueTracker.fetchTicket(ticketKey);
    return (
      ticket.trackerStatus.trim().toLowerCase() === env.COLUMN_AI.trim().toLowerCase() &&
      resolveTicketProjectKey(ticket) === env.JIRA_PROJECT_KEY.trim().toUpperCase()
    );
  } catch (error) {
    if (error instanceof IssueTrackerNotFoundError || getErrorCode(error) === "NOT_FOUND") {
      return false;
    }
    logger.warn(
      { ticketKey, error: (error as Error).message },
      "reconcile_closing_ticket_lookup_failed",
    );
    return null;
  }
}

async function recoverStaleReservation(
  entry: ActiveRunEntry,
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  onSubjectReleased?: SubjectReleasedCallback,
  db?: Db,
): Promise<number> {
  if (runRegistry.releaseExpiredReservation) {
    const released = await runRegistry
      .releaseExpiredReservation(entry.subjectKey, entry.ownerToken)
      .catch(() => false);
    if (!released) return 0;
    // A reservation cannot register a sandbox until its candidate binds, so
    // the atomic expiry delete has no external child to drain.
    await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
    logger.warn(
      { subjectKey: entry.subjectKey, ownerToken: entry.ownerToken },
      "reconcile_cleaned_stale_reservation",
    );
    return 1;
  }

  if (Date.now() - entry.updatedAt <= STALE_RESERVATION_MS) return 0;

  try {
    await stopOwnedSandboxes(entry, runRegistry);
  } catch (error) {
    logger.warn(
      { subjectKey: entry.subjectKey, error: (error as Error).message },
      "reconcile_stale_reservation_cleanup_unconfirmed",
    );
    return 0;
  }
  const released = await runRegistry
    .releaseReservation(entry.subjectKey, entry.ownerToken)
    .catch(() => false);
  if (!released) return 0;
  await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
  logger.warn(
    { subjectKey: entry.subjectKey, ownerToken: entry.ownerToken },
    "reconcile_cleaned_stale_reservation",
  );
  return 1;
}

async function cleanFinishedRun(
  entry: ActiveRunEntry & { runId: string },
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  onSubjectReleased?: SubjectReleasedCallback,
  db?: Db,
): Promise<number> {
  try {
    const status = await getRun(entry.runId).status;
    if (!TERMINAL_STATUSES.has(status)) return 0;
    if (!(await confirmWorkflowStepsDrained(entry.subjectKey, entry.runId))) return 0;
    const released = await cleanupAndRelease(entry, runRegistry);
    if (!released) return 0;
    await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
    logger.info(
      { subjectKey: entry.subjectKey, runId: entry.runId, status },
      "reconcile_cleaned_finished_run",
    );
    return 1;
  } catch (error) {
    // Reachability is not terminal proof. Retain the exact owner until Workflow
    // reports a terminal status (or a separately verified cancellation does).
    logger.warn(
      {
        subjectKey: entry.subjectKey,
        runId: entry.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "reconcile_run_status_unreachable_owner_retained",
    );
    return 0;
  }
}

async function cleanFinishedManualTicket(
  entry: ActiveRunEntry & { runId: string },
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  onSubjectReleased?: SubjectReleasedCallback,
  db?: Db,
): Promise<number> {
  try {
    const status = await getRun(entry.runId).status;
    if (!TERMINAL_STATUSES.has(status)) return 0;
    if (!(await confirmWorkflowStepsDrained(entry.subjectKey, entry.runId))) return 0;
    if (!entry.ticketKey || !issueTracker || !db) return 0;

    await withdrawTicketFromAiForRun({
      db,
      issueTracker,
      ticketKey: entry.ticketKey,
      aiColumn: env.COLUMN_AI,
      target: env.JIRA_BACKLOG_TRANSITION_ID
        ? { name: env.COLUMN_BACKLOG, transitionId: env.JIRA_BACKLOG_TRANSITION_ID }
        : env.COLUMN_BACKLOG,
      owner: entry,
      requiredOwnerState: "bound",
    });

    const released = await cleanupAndRelease(entry, runRegistry);
    if (!released) return 0;
    await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
    logger.info(
      { subjectKey: entry.subjectKey, runId: entry.runId, status },
      "reconcile_cleaned_finished_manual_ticket",
    );
    return 1;
  } catch (error) {
    logger.warn(
      {
        subjectKey: entry.subjectKey,
        runId: entry.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "reconcile_manual_ticket_withdrawal_unconfirmed",
    );
    return 0;
  }
}

/**
 * A ticket-triggered run whose ticket is STILL in the AI column, exactly like
 * every genuinely in-progress run - so this only acts once the world confirms
 * the run itself is terminal. At that point the graph is done and nobody
 * moved the ticket, so the platform evicts it to Backlog instead of quietly
 * releasing the claim: releasing without evicting is what let the next poll's
 * JQL discovery see the same ticket and dispatch a second run.
 *
 * Reuses cancelRunDetailed - the exact machinery the "ticket already left AI"
 * branch below uses - which already tolerates a run that is already terminal
 * (workflowRun.cancel() throws, the status re-read confirms it, and the move +
 * release still complete). No "canceled" notification is fired for this path:
 * the run may well have succeeded (e.g. an injection screen's "done" block),
 * so telling an operator it was canceled would be a lie.
 */
async function cleanStuckTicketRun(
  entry: ActiveRunEntry & { runId: string },
  ticketKey: string,
  runRegistry: RunRegistryAdapter,
  issueTracker: IssueTrackerAdapter | undefined,
  onSubjectReleased?: SubjectReleasedCallback,
): Promise<number> {
  try {
    const status = await getRun(entry.runId).status;
    if (!TERMINAL_STATUSES.has(status)) return 0;
  } catch (error) {
    logger.warn(
      {
        subjectKey: entry.subjectKey,
        runId: entry.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "reconcile_run_status_unreachable_owner_retained",
    );
    return 0;
  }

  if (!issueTracker) return 0;

  const backlogTarget: IssueTrackerMoveTarget = env.JIRA_BACKLOG_TRANSITION_ID
    ? { name: env.COLUMN_BACKLOG, transitionId: env.JIRA_BACKLOG_TRANSITION_ID }
    : env.COLUMN_BACKLOG;

  const result = await cancelRunDetailed(
    ticketKey,
    entry.runId,
    runRegistry,
    issueTracker,
    backlogTarget,
    onSubjectReleased,
    STUCK_TICKET_EVICTION_REASON,
  );
  if (!result.cancelled) {
    logger.warn(
      { ticketKey, runId: entry.runId },
      "reconcile_stuck_ticket_evict_unconfirmed",
    );
    return 0;
  }
  logger.info(
    { ticketKey, runId: entry.runId },
    "reconcile_evicted_stuck_ticket_from_ai_column",
  );
  return 1;
}

async function cleanupAndRelease(
  entry: ActiveRunEntry & { runId: string },
  runRegistry: RunRegistryAdapter,
): Promise<boolean> {
  try {
    await stopOwnedSandboxes(entry, runRegistry);
  } catch (error) {
    logger.warn(
      { subjectKey: entry.subjectKey, runId: entry.runId, error: (error as Error).message },
      "reconcile_terminal_sandbox_cleanup_unconfirmed",
    );
    return false;
  }
  return runRegistry
    .release(entry.subjectKey, entry.ownerToken, entry.runId)
    .catch(() => false);
}

async function stopOwnedSandboxes(
  entry: Pick<ActiveRunEntry, "subjectKey" | "ownerToken">,
  runRegistry: RunRegistryAdapter,
): Promise<void> {
  const sandboxIds = await runRegistry
    .listSandboxes(entry.subjectKey, entry.ownerToken);
  await stopSandboxesByIds(sandboxIds);
}

async function verifyTicketLeftAiColumn(
  ticketKey: string,
  issueTracker?: IssueTrackerAdapter,
): Promise<{
  left: boolean;
  trackerStatus: string | null;
  trackerStatusId: string | null;
}> {
  if (!issueTracker) return { left: true, trackerStatus: null, trackerStatusId: null };

  try {
    const ticket = await issueTracker.fetchTicket(ticketKey);
    const ticketStatus = ticket.trackerStatus.trim().toLowerCase();
    const expectedStatus = env.COLUMN_AI.trim().toLowerCase();
    const ticketProjectKey = resolveTicketProjectKey(ticket);
    const expectedProjectKey = env.JIRA_PROJECT_KEY.trim().toUpperCase();
    const trackerStatusId = ticket.trackerStatusId ?? null;
    if (ticketStatus === expectedStatus && ticketProjectKey === expectedProjectKey) {
      logger.info(
        { ticketKey, status: ticket.trackerStatus, projectKey: ticketProjectKey },
        "reconcile_kept_run_missing_from_poll_snapshot",
      );
      return { left: false, trackerStatus: ticket.trackerStatus, trackerStatusId };
    }
    return { left: true, trackerStatus: ticket.trackerStatus, trackerStatusId };
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError || getErrorCode(err) === "NOT_FOUND") {
      return { left: true, trackerStatus: null, trackerStatusId: null };
    }
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "reconcile_orphan_verification_failed",
    );
    return { left: false, trackerStatus: null, trackerStatusId: null };
  }
}

/**
 * A ticket sitting in the AI Review column is retained while its bound run is
 * still executing only when the exact run has a recorded outcome or durable
 * PR/publication evidence. That preserves the genuine post-PR finalization
 * race without treating an eager human move with no evidence as success.
 * Once the Workflow world is terminal, release it through this same orphan
 * path (cancelRun's already-terminal branch) exactly as for normal completion.
 */
async function shouldRetainFinalizingRunInAiReview(
  ticketKey: string,
  runId: string,
  db?: Db,
): Promise<boolean> {
  const decision = await decideAiReviewRun(db, runId);
  if (decision === "lookup_failed") {
    logger.warn(
      { ticketKey, runId },
      "reconcile_ai_review_run_evidence_lookup_failed",
    );
    return true;
  }
  if (decision === "cancel") return false;
  try {
    const status = await getRun(runId).status;
    if (TERMINAL_STATUSES.has(status)) return false;
  } catch {
    // Reachability is not terminal proof (same rule as cleanFinishedRun):
    // retain the exact owner and let a later tick decide.
  }
  logger.info(
    { ticketKey, runId },
    "reconcile_retained_finalizing_run_in_ai_review",
  );
  return true;
}

function resolveTicketProjectKey(ticket: {
  projectKey?: string;
  identifier: string;
}): string | null {
  const direct = ticket.projectKey?.trim();
  if (direct) return direct.toUpperCase();
  const dashIndex = ticket.identifier.trim().indexOf("-");
  return dashIndex > 0 ? ticket.identifier.trim().slice(0, dashIndex).toUpperCase() : null;
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const maybeCode = (err as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}

async function notifyTicketCancelled(
  ticketKey: string,
  reason: TicketCancellationReason,
  callback?: TicketCancellationCallback,
): Promise<void> {
  if (!callback) return;
  try {
    await callback(ticketKey, reason);
  } catch (err) {
    logger.warn(
      { ticketKey, reason, error: (err as Error).message },
      "reconcile_cancel_notification_failed",
    );
  }
}

async function notifySubjectReleased(
  subjectKey: string,
  callback?: SubjectReleasedCallback,
): Promise<void> {
  if (!callback) return;
  try {
    await callback(subjectKey);
  } catch (err) {
    logger.warn(
      { subjectKey, error: (err as Error).message },
      "reconcile_pending_drain_failed",
    );
  }
}
