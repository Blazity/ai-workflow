import { getRun } from "workflow/api";
import { env } from "../../env.js";
import { cancelRun, cancelSubjectRun } from "./cancel-run.js";
import { logger } from "./logger.js";
import { stopSandboxesByIds } from "../sandbox/stop-ticket-sandboxes.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
} from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { confirmWorkflowStepsDrained } from "./workflow-step-drain.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STALE_RESERVATION_MS = 5 * 60 * 1000;
const ORPHAN_GRACE_MS = 30 * 1000;

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
  const entries = await runRegistry.listAll();
  let cancelled = 0;
  let cleaned = 0;

  for (const listedEntry of entries) {
    let entry = listedEntry;
    // Cancellation failures deliberately retain a dispatch-blocking closing
    // claim. Retry that durable intent before any parked/terminal/orphan logic;
    // a clarification tombstone may have made a previously parked subject
    // closing, and it must not be skipped by the old protection snapshot.
    if (entry.state === "cancelling") {
      const confirmed = await retryCancellingClaim(
        entry,
        runRegistry,
        issueTracker,
        onSubjectReleased,
      );
      if (confirmed) {
        await notifyTicketCancelled(
          entry.ticketKey ?? "",
          entry.runId ? "orphaned_run" : "inflight_claim",
          entry.ticketKey ? onTicketCancelled : undefined,
        );
        cancelled++;
      }
      continue;
    }

    if (entry.state === "parking") {
      const recovered = await recoverParkingClaim(entry, runRegistry);
      if (!recovered) continue;
      entry = recovered;
    }

    // A pending durable clarification intentionally keeps its predecessor
    // parked after the Workflow run exits and the ticket has left AI. The
    // answer path needs that exact claim for its owner-CAS successor handoff.
    if (parkedSubjects?.has(entry.subjectKey)) continue;

    // A consumed clarification successor is allowed to run while the ticket is
    // outside AI, but it is not a retained parked predecessor. Reconcile only
    // its terminal cleanup so a failed best-effort release cannot leak the
    // exact bound owner forever.
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

    if (!followsTicketColumn || ticketStillInAiColumn) {
      cleaned += await cleanFinishedRun(
        boundEntry,
        runRegistry,
        issueTracker,
        onSubjectReleased,
        db,
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
    if (
      await shouldRetainFinalizingRunInAiReview(
        ticketKey,
        entry.runId,
        departure.trackerStatus,
      )
    ) {
      continue;
    }

    const cancellationConfirmed = await cancelRun(
      ticketKey,
      entry.runId,
      runRegistry,
      issueTracker,
      undefined,
      onSubjectReleased,
    );
    if (!cancellationConfirmed) {
      logger.warn({ ticketKey, runId: entry.runId }, "reconcile_orphan_cancel_unconfirmed");
      continue;
    }
    logger.info({ ticketKey, runId: entry.runId }, "reconcile_cancelled_orphaned_run");
    await notifyTicketCancelled(ticketKey, "orphaned_run", onTicketCancelled);
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
): Promise<boolean> {
  const target = { ownerToken: entry.ownerToken, runId: entry.runId };
  if (!entry.ticketKey) {
    return cancelSubjectRun(
      entry.subjectKey,
      target,
      runRegistry,
      onSubjectReleased,
    );
  }

  const inAiColumn = await readLiveTicketInAiColumn(entry.ticketKey, issueTracker);
  if (inAiColumn === null) {
    logger.warn(
      { ticketKey: entry.ticketKey, runId: entry.runId },
      "reconcile_closing_ticket_state_unconfirmed",
    );
    return false;
  }
  const backlogTarget = env.JIRA_BACKLOG_TRANSITION_ID
    ? { name: env.COLUMN_BACKLOG, transitionId: env.JIRA_BACKLOG_TRANSITION_ID }
    : env.COLUMN_BACKLOG;
  return cancelRun(
    entry.ticketKey,
    target,
    runRegistry,
    issueTracker,
    inAiColumn ? backlogTarget : undefined,
    onSubjectReleased,
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
): Promise<{ left: boolean; trackerStatus: string | null }> {
  if (!issueTracker) return { left: true, trackerStatus: null };

  try {
    const ticket = await issueTracker.fetchTicket(ticketKey);
    const ticketStatus = ticket.trackerStatus.trim().toLowerCase();
    const expectedStatus = env.COLUMN_AI.trim().toLowerCase();
    const ticketProjectKey = resolveTicketProjectKey(ticket);
    const expectedProjectKey = env.JIRA_PROJECT_KEY.trim().toUpperCase();
    if (ticketStatus === expectedStatus && ticketProjectKey === expectedProjectKey) {
      logger.info(
        { ticketKey, status: ticket.trackerStatus, projectKey: ticketProjectKey },
        "reconcile_kept_run_missing_from_poll_snapshot",
      );
      return { left: false, trackerStatus: ticket.trackerStatus };
    }
    return { left: true, trackerStatus: ticket.trackerStatus };
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError || getErrorCode(err) === "NOT_FOUND") {
      return { left: true, trackerStatus: null };
    }
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "reconcile_orphan_verification_failed",
    );
    return { left: false, trackerStatus: null };
  }
}

/**
 * A ticket sitting in the AI Review column while its bound run is still
 * executing is the run's own success destination reached early: a Jira
 * automation rule (or an eager human) raced the run's final self-move as soon
 * as the PR appeared, before the run could freeze its "success" status.
 * Cancelling would record that genuine success as "cancelled"/"blocked".
 * Retain the owner until the Workflow world reports a terminal status; the
 * next tick then releases it through this same orphan path (cancelRun's
 * already-terminal branch) exactly as for a normal completion.
 */
async function shouldRetainFinalizingRunInAiReview(
  ticketKey: string,
  runId: string,
  trackerStatus: string | null,
): Promise<boolean> {
  if (
    trackerStatus === null ||
    trackerStatus.trim().toLowerCase() !== env.COLUMN_AI_REVIEW.trim().toLowerCase()
  ) {
    return false;
  }
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
