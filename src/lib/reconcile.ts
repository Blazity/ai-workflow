import { getRun } from "workflow/api";
import { env } from "../../env.js";
import { isClaimingSentinel, getClaimTimestamp } from "./dispatch.js";
import { cancelRun } from "./cancel-run.js";
import { logger } from "./logger.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Track consecutive getRun failures per ticket.
 * Only unregister after UNREACHABLE_STRIKES_LIMIT consecutive failures
 * to avoid nuking dedup entries on transient WDK API errors
 * (especially during workflow sleep/suspend states).
 */
const unreachableStrikes = new Map<string, number>();
const UNREACHABLE_STRIKES_LIMIT = 3;

export async function reconcileRuns(
  aiColumnTickets: Set<string>,
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  onTicketCancelled?: (
    ticketKey: string,
    reason: "orphaned_run" | "inflight_claim",
  ) => Promise<void> | void,
): Promise<{ cancelled: number; cleaned: number }> {
  const activeRuns = await runRegistry.listAll();
  let cancelled = 0;
  let cleaned = 0;

  for (const { ticketKey, runId } of activeRuns) {
    if (isClaimingSentinel(runId)) {
      const result = await reconcileInflightClaim(
        ticketKey,
        runId,
        aiColumnTickets,
        runRegistry,
        issueTracker,
        onTicketCancelled,
      );
      cancelled += result.cancelled;
      cleaned += result.cleaned;
      continue;
    }

    const ticketStillInAiColumn = aiColumnTickets.has(ticketKey);

    if (ticketStillInAiColumn) {
      cleaned += await cleanFinishedRun(ticketKey, runId, runRegistry);
    } else {
      const leftAiColumn = await verifyTicketLeftAiColumn(ticketKey, issueTracker);
      if (!leftAiColumn) continue;
      await cancelRun(ticketKey, runId, runRegistry);
      logger.info({ ticketKey, runId }, "reconcile_cancelled_orphaned_run");
      await notifyTicketCancelled(ticketKey, "orphaned_run", onTicketCancelled);
      cancelled++;
    }
  }

  // Clean up failed-ticket markers for tickets that left the AI column
  const failedTickets = await runRegistry.listAllFailed();
  for (const { ticketKey } of failedTickets) {
    if (!aiColumnTickets.has(ticketKey)) {
      await runRegistry.clearFailedMark(ticketKey);
      logger.info({ ticketKey }, "reconcile_cleared_failed_mark");
    }
  }

  return { cancelled, cleaned };
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
    const stillInExpectedAiColumn =
      ticketStatus === expectedStatus && ticketProjectKey === expectedProjectKey;

    if (stillInExpectedAiColumn) {
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

  const identifier = ticket.identifier?.trim();
  if (!identifier) return null;

  const dashIndex = identifier.indexOf("-");
  if (dashIndex <= 0) return null;
  return identifier.slice(0, dashIndex).toUpperCase();
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const maybeCode = (err as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}

async function reconcileInflightClaim(
  ticketKey: string,
  runId: string,
  aiColumnTickets: Set<string>,
  runRegistry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  onTicketCancelled?: (
    ticketKey: string,
    reason: "orphaned_run" | "inflight_claim",
  ) => Promise<void> | void,
): Promise<{ cancelled: number; cleaned: number }> {
  const claimAge = Date.now() - getClaimTimestamp(runId);
  const claimIsStale = claimAge > STALE_CLAIM_MS;
  const ticketLeftAiColumn = !aiColumnTickets.has(ticketKey);

  if (claimIsStale) {
    await runRegistry.unregister(ticketKey);
    logger.warn({ ticketKey, runId }, "reconcile_cleaned_stale_claim");
    return { cancelled: 0, cleaned: 1 };
  }

  if (ticketLeftAiColumn) {
    const leftAiColumn = await verifyTicketLeftAiColumn(ticketKey, issueTracker);
    if (!leftAiColumn) return { cancelled: 0, cleaned: 0 };
    await runRegistry.unregister(ticketKey);
    logger.info({ ticketKey, runId }, "reconcile_cancelled_inflight_claim");
    await notifyTicketCancelled(ticketKey, "inflight_claim", onTicketCancelled);
    return { cancelled: 1, cleaned: 0 };
  }

  return { cancelled: 0, cleaned: 0 };
}

async function notifyTicketCancelled(
  ticketKey: string,
  reason: "orphaned_run" | "inflight_claim",
  onTicketCancelled?: (
    ticketKey: string,
    reason: "orphaned_run" | "inflight_claim",
  ) => Promise<void> | void,
): Promise<void> {
  if (!onTicketCancelled) return;
  try {
    await onTicketCancelled(ticketKey, reason);
  } catch (err) {
    logger.warn(
      { ticketKey, reason, error: (err as Error).message },
      "reconcile_cancel_notification_failed",
    );
  }
}

async function cleanFinishedRun(
  ticketKey: string,
  runId: string,
  runRegistry: RunRegistryAdapter,
): Promise<number> {
  try {
    const run = getRun(runId);
    const status = await run.status;

    // Success — reset strike counter
    unreachableStrikes.delete(ticketKey);

    if (!TERMINAL_STATUSES.has(status)) return 0;

    await runRegistry.unregister(ticketKey);
    logger.info({ ticketKey, runId, status }, "reconcile_cleaned_finished_run");
    return 1;
  } catch {
    const strikes = (unreachableStrikes.get(ticketKey) ?? 0) + 1;
    unreachableStrikes.set(ticketKey, strikes);

    if (strikes < UNREACHABLE_STRIKES_LIMIT) {
      logger.warn(
        { ticketKey, runId, strikes, limit: UNREACHABLE_STRIKES_LIMIT },
        "reconcile_unreachable_strike",
      );
      return 0;
    }

    // Exceeded strike limit — genuinely gone
    unreachableStrikes.delete(ticketKey);
    await runRegistry.unregister(ticketKey).catch(() => {});
    logger.warn({ ticketKey, runId }, "reconcile_cleaned_unreachable_run");
    return 1;
  }
}
