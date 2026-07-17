import { getRun } from "workflow/api";
import { env } from "../../env.js";
import { cancelRun } from "./cancel-run.js";
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

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STALE_RESERVATION_MS = 5 * 60 * 1000;
const ORPHAN_GRACE_MS = 30 * 1000;
const UNREACHABLE_STRIKES_LIMIT = 3;
const unreachableStrikes = new Map<string, number>();

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
): Promise<{ cancelled: number; cleaned: number }> {
  const entries = await runRegistry.listAll();
  let cancelled = 0;
  let cleaned = 0;

  for (const entry of entries) {
    if (entry.state === "reserved") {
      cleaned += await recoverStaleReservation(entry, runRegistry, onSubjectReleased);
      continue;
    }
    if (!entry.runId) continue;
    const boundEntry = { ...entry, runId: entry.runId };

    const followsTicketColumn = entry.kind === "ticket" && entry.ticketKey !== null;
    const ticketStillInAiColumn =
      followsTicketColumn && aiColumnTickets.has(entry.ticketKey as string);

    if (!followsTicketColumn || ticketStillInAiColumn) {
      cleaned += await cleanFinishedRun(boundEntry, runRegistry, onSubjectReleased);
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
    if (!(await verifyTicketLeftAiColumn(ticketKey, issueTracker))) continue;

    await cancelRun(
      ticketKey,
      entry.runId,
      runRegistry,
      undefined,
      undefined,
      onSubjectReleased,
    );
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

async function recoverStaleReservation(
  entry: ActiveRunEntry,
  runRegistry: RunRegistryAdapter,
  onSubjectReleased?: SubjectReleasedCallback,
): Promise<number> {
  if (Date.now() - entry.updatedAt <= STALE_RESERVATION_MS) return 0;

  await stopOwnedSandboxes(entry, runRegistry);
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
  onSubjectReleased?: SubjectReleasedCallback,
): Promise<number> {
  try {
    const status = await getRun(entry.runId).status;
    unreachableStrikes.delete(entry.subjectKey);
    if (!TERMINAL_STATUSES.has(status)) return 0;

    const released = await cleanupAndRelease(entry, runRegistry);
    if (!released) return 0;
    await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
    logger.info(
      { subjectKey: entry.subjectKey, runId: entry.runId, status },
      "reconcile_cleaned_finished_run",
    );
    return 1;
  } catch {
    const strikes = (unreachableStrikes.get(entry.subjectKey) ?? 0) + 1;
    unreachableStrikes.set(entry.subjectKey, strikes);
    if (strikes < UNREACHABLE_STRIKES_LIMIT) {
      logger.warn(
        {
          subjectKey: entry.subjectKey,
          runId: entry.runId,
          strikes,
          limit: UNREACHABLE_STRIKES_LIMIT,
        },
        "reconcile_unreachable_strike",
      );
      return 0;
    }

    unreachableStrikes.delete(entry.subjectKey);
    const released = await cleanupAndRelease(entry, runRegistry);
    if (!released) return 0;
    await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
    logger.warn(
      { subjectKey: entry.subjectKey, runId: entry.runId },
      "reconcile_cleaned_unreachable_run",
    );
    return 1;
  }
}

async function cleanupAndRelease(
  entry: ActiveRunEntry & { runId: string },
  runRegistry: RunRegistryAdapter,
): Promise<boolean> {
  await stopOwnedSandboxes(entry, runRegistry);
  return runRegistry
    .release(entry.subjectKey, entry.ownerToken, entry.runId)
    .catch(() => false);
}

async function stopOwnedSandboxes(
  entry: Pick<ActiveRunEntry, "subjectKey" | "ownerToken">,
  runRegistry: RunRegistryAdapter,
): Promise<void> {
  const sandboxIds = await runRegistry
    .listSandboxes(entry.subjectKey, entry.ownerToken)
    .catch(() => []);
  await stopSandboxesByIds(sandboxIds).catch(() => {});
}

async function verifyTicketLeftAiColumn(
  ticketKey: string,
  issueTracker?: IssueTrackerAdapter,
): Promise<boolean> {
  if (!issueTracker) return true;

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
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError || getErrorCode(err) === "NOT_FOUND") {
      return true;
    }
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "reconcile_orphan_verification_failed",
    );
    return false;
  }
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
