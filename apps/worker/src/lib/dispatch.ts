import { start, getRun } from "workflow/api";
import { env } from "../../env.js";
import { agentWorkflow } from "../workflows/agent.js";
import { logger } from "./logger.js";
import { runLabel } from "./labels.js";
import type { Adapters } from "./adapters.js";
import { stopTicketSandboxes } from "../sandbox/stop-ticket-sandboxes.js";

const CLAIMING_PREFIX = "claiming:";
/**
 * Stale-claim horizon — claiming sentinels older than this are ignored
 * when counting active runs for capacity. Matches the reconcile threshold
 * (src/lib/reconcile.ts) so a crashed dispatch can't deadlock capacity
 * for longer than reconcile would take to sweep it anyway.
 */
export const STALE_CLAIM_MS = 5 * 60 * 1000;

export function isClaimingSentinel(runId: string): boolean {
  return runId.startsWith(CLAIMING_PREFIX);
}

export function getClaimTimestamp(runId: string): number {
  return parseInt(runId.slice(CLAIMING_PREFIX.length), 10);
}

export interface DispatchResult {
  started: boolean;
  runId?: string;
  reason?:
    | "already_claimed"
    | "at_capacity"
    | "error"
    | "previously_failed"
    | "not_in_ai_column"
    | "wrong_project_key";
}

export async function dispatchTicket(
  ticketKey: string,
  adapters: Adapters,
  maxConcurrentAgents: number,
): Promise<DispatchResult> {
  const expectedProjectKey = env.JIRA_PROJECT_KEY.trim().toUpperCase();
  const expectedAiStatus = env.COLUMN_AI.trim().toLowerCase();
  const { issueTracker, runRegistry } = adapters;
  let stage = "precheck_failed_marker";
  let claimHeld = false;
  let claimValue = "";
  try {
    logger.info({ ticketKey, maxConcurrentAgents }, "dispatch_attempt");

    if (await runRegistry.isTicketFailed(ticketKey)) {
      logger.info({ ticketKey }, "dispatch_skipped_previously_failed");
      return { started: false, reason: "previously_failed" };
    }

    stage = "precheck_capacity";
    if (await isAtCapacity(maxConcurrentAgents, runRegistry)) {
      return { started: false, reason: "at_capacity" };
    }

    stage = "claim_ticket";
    claimValue = `${CLAIMING_PREFIX}${Date.now()}`;
    const claimed = await runRegistry.claim(ticketKey, claimValue);
    if (!claimed) {
      logger.info({ ticketKey }, "dispatch_already_claimed");
      return { started: false, reason: "already_claimed" };
    }
    claimHeld = true;

    // Post-claim capacity verify. The precheck above is not atomic with
    // claim(), so N concurrent dispatches for *different* tickets can all
    // pass the precheck and then all claim successfully — pushing Redis
    // over the cap. Re-read the registry with our own claim visible and
    // decide fairly who stays.
    //
    // Fairness rule: sort by (claim timestamp ascending, ticketKey
    // ascending as tie-breaker); the first `max` entries win. Existing
    // non-sentinel entries (already-running workflows) are treated as
    // timestamp 0 so they always win over new claims. Every racer
    // eventually converges on the same ordering once Redis writes are
    // visible to all, so exactly the excess bail.
    stage = "postclaim_capacity";
    const racers = await runRegistry.listAll();
    const now = Date.now();
    const liveRacers = racers.filter(({ runId }) => {
      if (!isClaimingSentinel(runId)) return true;
      return now - getClaimTimestamp(runId) <= STALE_CLAIM_MS;
    });
    if (liveRacers.length > maxConcurrentAgents) {
      const sorted = [...liveRacers].sort((a, b) => {
        const ta = isClaimingSentinel(a.runId) ? getClaimTimestamp(a.runId) : 0;
        const tb = isClaimingSentinel(b.runId) ? getClaimTimestamp(b.runId) : 0;
        if (ta !== tb) return ta - tb;
        return a.ticketKey.localeCompare(b.ticketKey);
      });
      const winners = new Set(
        sorted.slice(0, maxConcurrentAgents).map((e) => e.ticketKey),
      );
      if (!winners.has(ticketKey)) {
        await runRegistry.unregister(ticketKey).catch(() => {});
        claimHeld = false;
        logger.info(
          { ticketKey, liveRacers: liveRacers.length, max: maxConcurrentAgents },
          "dispatch_at_capacity_post_claim",
        );
        return { started: false, reason: "at_capacity" };
      }
    }

    stage = "fetch_ticket";
    const ticket = await issueTracker.fetchTicket(ticketKey);
    const ticketStatus = ticket.trackerStatus.trim().toLowerCase();
    if (ticketStatus !== expectedAiStatus) {
      await runRegistry.unregister(ticketKey).catch(() => {});
      logger.info(
        { ticketKey, ticketStatus: ticket.trackerStatus, expectedStatus: env.COLUMN_AI },
        "dispatch_skipped_not_in_ai_column",
      );
      return { started: false, reason: "not_in_ai_column" };
    }

    const ticketProjectKey = extractProjectKey(ticket.identifier);
    if (!ticketProjectKey || ticketProjectKey !== expectedProjectKey) {
      await runRegistry.unregister(ticketKey).catch(() => {});
      logger.info(
        {
          ticketKey,
          ticketIdentifier: ticket.identifier,
          ticketProjectKey,
          expectedProjectKey: env.JIRA_PROJECT_KEY,
        },
        "dispatch_skipped_wrong_project_key",
      );
      return { started: false, reason: "wrong_project_key" };
    }

    stage = "start_workflow";
    // Pass the issue key (not the numeric id) so the workflow can build
    // /browse/{KEY}?focusedCommentId=... deep links in Slack notifications.
    // Jira's REST API accepts either id or key for fetch/transition/comment.
    const handle = await start(agentWorkflow, [ticketKey]);
    logger.info(
      { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
      "workflow_started",
    );

    stage = "verify_claim_after_start";
    const claimStillHeld = await verifyClaimNotCancelled(
      ticketKey,
      claimValue,
      runRegistry,
    );
    if (!claimStillHeld) {
      await abortWorkflow(handle.runId, ticketKey);
      return { started: false, reason: "already_claimed" };
    }

    stage = "register_run";
    await runRegistry.register(ticketKey, handle.runId);

    // Durable ticket↔run mapping: tag the ticket with its runId so the
    // dashboard (and operators in Jira) can recover which run processed it,
    // even after the run completes and its encrypted workflow input is no
    // longer decodable. Best-effort — the workflow has already started, so a
    // label failure must not fail the dispatch. Add-only: labels accumulate so
    // a re-dispatched ticket keeps one `run:<id>` label per run.
    if (typeof issueTracker.updateLabels === "function") {
      try {
        await issueTracker.updateLabels(ticketKey, { add: [runLabel(handle.runId)] });
      } catch (err) {
        logger.warn(
          { ticketKey, runId: handle.runId, err: errorMessage(err) },
          "run_label_add_failed",
        );
      }
    }

    return { started: true, runId: handle.runId };
  } catch (err) {
    if (claimHeld) {
      await runRegistry.unregister(ticketKey).catch(() => {});
    }
    logger.warn(
      { ticketKey, stage, error: (err as Error).message },
      "dispatch_error",
    );
    return { started: false, reason: "error" };
  }
}

/**
 * Capacity check counts active runs in the Redis registry — this is the
 * per-app concurrency limit for blazebot, not a per-team sandbox quota.
 *
 * We deliberately exclude claiming sentinels older than STALE_CLAIM_MS so
 * a crashed dispatch can't deadlock capacity indefinitely; reconcile will
 * sweep those stale entries on its next run, but the capacity check
 * shouldn't wait for it.
 *
 * Fails closed on registry errors — better to stall new dispatches than
 * to over-allocate if we can't see the current state.
 */
async function isAtCapacity(
  max: number,
  runRegistry: Adapters["runRegistry"],
): Promise<boolean> {
  let entries: Awaited<ReturnType<Adapters["runRegistry"]["listAll"]>>;
  try {
    entries = await runRegistry.listAll();
  } catch (err) {
    logger.warn(
      { max, error: (err as Error).message },
      "dispatch_capacity_check_failed_closed",
    );
    return true;
  }

  const now = Date.now();
  const active = entries.filter(({ runId }) => {
    if (!isClaimingSentinel(runId)) return true;
    return now - getClaimTimestamp(runId) <= STALE_CLAIM_MS;
  }).length;

  if (active < max) return false;

  logger.info({ active, max }, "dispatch_at_capacity");
  return true;
}

async function verifyClaimNotCancelled(
  ticketKey: string,
  expectedClaimValue: string,
  runRegistry: Adapters["runRegistry"],
): Promise<boolean> {
  const currentValue = await runRegistry.getRunId(ticketKey);
  return currentValue === expectedClaimValue;
}

async function abortWorkflow(runId: string, ticketKey: string): Promise<void> {
  logger.info({ ticketKey, runId }, "dispatch_aborted_claim_cancelled");
  try {
    const run = getRun(runId);
    await run.cancel();
  } catch {}
  await stopTicketSandboxes(ticketKey).catch(() => {});
}

function extractProjectKey(ticketIdentifier: string): string | null {
  const trimmed = ticketIdentifier.trim();
  if (!trimmed) return null;
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex <= 0) return null;
  return trimmed.slice(0, dashIndex).toUpperCase();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
