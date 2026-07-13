import { getRun } from "workflow/api";
import { env } from "../../env.js";
import { isClaimingSentinel, getClaimTimestamp } from "./dispatch.js";
import { cancelRun } from "./cancel-run.js";
import { logger } from "./logger.js";
import { stopTicketSandboxes } from "../sandbox/stop-ticket-sandboxes.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type { RunKind, RunRegistryAdapter } from "../adapters/run-registry/types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Grace period applied to any cleanup that relies on "ticket isn't in the
 * AI-column snapshot." Jira's JQL index lags transitions by seconds, and
 * dispatch writes the registry entry before the transition commits, so a
 * ticket genuinely moving INTO AI can briefly look like an orphan. Skip
 * anything younger than this — reconcile runs every minute, so we'll pick
 * up a real orphan on the next tick.
 */
const ORPHAN_GRACE_MS = 30 * 1000;

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

  for (const { ticketKey, runId, kind } of activeRuns) {
    if (isClaimingSentinel(runId)) {
      const result = await reconcileInflightClaim(
        ticketKey,
        runId,
        kind,
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

    // A pr_trigger run follows the PR, not the ticket column, so it is never
    // cancelled for leaving the AI column. The terminal/unreachable sweep in
    // cleanFinishedRun still applies to it, regardless of the column.
    if (ticketStillInAiColumn || kind === "pr_trigger") {
      cleaned += await cleanFinishedRun(ticketKey, runId, runRegistry);
    } else {
      if (await isWithinGracePeriod(ticketKey, runRegistry)) {
        logger.info(
          { ticketKey, runId },
          "reconcile_skipped_fresh_orphan_in_grace",
        );
        continue;
      }
      const leftAiColumn = await verifyTicketLeftAiColumn(ticketKey, issueTracker);
      if (!leftAiColumn) continue;
      await cancelRun(ticketKey, runId, runRegistry);
      logger.info({ ticketKey, runId }, "reconcile_cancelled_orphaned_run");
      await notifyTicketCancelled(ticketKey, "orphaned_run", onTicketCancelled);
      cancelled++;
    }
  }

  // Clean up failed-ticket markers for tickets that left the AI column.
  // Respect the same grace window: a marker that was just written while
  // the ticket is mid-transition shouldn't be wiped on the first cron
  // tick that catches it between columns.
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

async function isWithinGracePeriod(
  ticketKey: string,
  runRegistry: RunRegistryAdapter,
): Promise<boolean> {
  const createdAt = await runRegistry
    .getEntryCreatedAt(ticketKey)
    .catch(() => null);
  if (createdAt == null) return false;
  return Date.now() - createdAt < ORPHAN_GRACE_MS;
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
  kind: RunKind,
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
    // Dispatch starts the workflow (which can spin up a sandbox in the
    // research phase) *before* overwriting the sentinel with the real
    // runId. A crash in that narrow window leaves a sentinel in Postgres
    // alongside a running sandbox we have no way to cancel via the
    // workflow handle. Try the fast path (sandboxId from Postgres); fall
    // back to the parallel branch scan if the workflow crashed before
    // writing its sandboxId.
    const sandboxId = await runRegistry
      .getSandboxId(ticketKey)
      .catch(() => null);
    await stopTicketSandboxes(ticketKey, sandboxId).catch(() => {});
    await runRegistry.unregister(ticketKey);
    logger.warn({ ticketKey, runId }, "reconcile_cleaned_stale_claim");
    return { cancelled: 0, cleaned: 1 };
  }

  if (ticketLeftAiColumn) {
    if (kind === "pr_trigger") {
      logger.info({ ticketKey, runId }, "reconcile_kept_pr_trigger_inflight_claim");
      return { cancelled: 0, cleaned: 0 };
    }
    const leftAiColumn = await verifyTicketLeftAiColumn(ticketKey, issueTracker);
    if (!leftAiColumn) return { cancelled: 0, cleaned: 0 };
    const sandboxId = await runRegistry
      .getSandboxId(ticketKey)
      .catch(() => null);
    await stopTicketSandboxes(ticketKey, sandboxId).catch(() => {});
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
