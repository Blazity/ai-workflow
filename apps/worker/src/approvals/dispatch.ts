import { getRun, start } from "workflow/api";
import type { Db } from "../db/client.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { AgentWorkflowInput } from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import { getEnabledWorkflowDefinitionForTrigger } from "../workflow-definition/store.js";
import { logger } from "../lib/logger.js";
import type { ApprovalRow } from "./store.js";

// Mirrored from lib/dispatch.ts (kept in sync deliberately, not imported, so
// this module stays free of the ticket-dispatch import chain): plan_approved
// runs share the same claiming-sentinel + stale-claim horizon as ticket runs.
const CLAIMING_PREFIX = "claiming:";
const STALE_CLAIM_MS = 5 * 60 * 1000;

function isClaimingSentinel(runId: string): boolean {
  return runId.startsWith(CLAIMING_PREFIX);
}

function getClaimTimestamp(runId: string): number {
  return parseInt(runId.slice(CLAIMING_PREFIX.length), 10);
}

export type DispatchPlanApprovedResult =
  | { status: "no_enabled_definition" }
  | { status: "run_in_flight" }
  | { status: "started"; runId: string };

/**
 * Starts a trigger_plan_approved run for an approved plan. Mirrors the
 * claim + capacity dance in lib/dispatch.ts (claiming sentinel, post-claim
 * fairness re-check) so plan_approved runs count against the same per-app
 * concurrency limit as ticket runs, then registers the run under a plain
 * ticket entry (no run-kind param) so reconcile treats it like any other.
 *
 * The optional onClaimed gate runs once the ticket is reserved and before the
 * workflow starts; a caller passes the compare-and-set decision there so the
 * claim protects the decision (throwing releases the claim). Callers map the
 * three result statuses onto their own responses.
 */
export async function dispatchPlanApproved(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  approval: ApprovalRow;
  actor: { id: string; label: string };
  maxConcurrentAgents: number;
  onClaimed?: () => Promise<void>;
}): Promise<DispatchPlanApprovedResult> {
  const { db, runRegistry, approval, actor, maxConcurrentAgents, onClaimed } = input;
  const ticketKey = approval.ticketKey;

  const enabled = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_plan_approved");
  if (!enabled) {
    logger.info({ ticketKey }, "plan_approved_no_enabled_definition");
    return { status: "no_enabled_definition" };
  }

  if (await isAtCapacity(maxConcurrentAgents, runRegistry)) {
    return { status: "run_in_flight" };
  }

  const claimValue = `${CLAIMING_PREFIX}${Date.now()}`;
  const claimed = await runRegistry.claim(ticketKey, claimValue);
  if (!claimed) {
    logger.info({ ticketKey }, "plan_approved_already_claimed");
    return { status: "run_in_flight" };
  }
  let claimHeld = true;

  try {
    // Post-claim fairness re-check (mirrors lib/dispatch.ts): the precheck is
    // not atomic with claim(), so re-read with our own claim visible and bail
    // if we are over the cap.
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
      const winners = new Set(sorted.slice(0, maxConcurrentAgents).map((e) => e.ticketKey));
      if (!winners.has(ticketKey)) {
        await runRegistry.unregister(ticketKey).catch(() => {});
        claimHeld = false;
        return { status: "run_in_flight" };
      }
    }

    if (onClaimed) {
      await onClaimed();
    }

    const entry: AgentWorkflowInput = {
      kind: "plan_approved",
      ticketKey,
      definitionId: approval.definitionId,
      approvedPlan: {
        markdown: approval.plan.markdown,
        assumptions: approval.assumptions ?? undefined,
      },
      approval: {
        approvalRequestId: approval.id,
        approver: actor.label,
        approvedAt: new Date().toISOString(),
      },
    };
    const handle = await start(agentWorkflow, [entry]);
    logger.info({ ticketKey, runId: handle.runId }, "plan_approved_workflow_started");

    const stillHeld = (await runRegistry.getRunId(ticketKey)) === claimValue;
    if (!stillHeld) {
      await abortWorkflow(handle.runId);
      claimHeld = false;
      return { status: "run_in_flight" };
    }

    await runRegistry.register(ticketKey, handle.runId);
    claimHeld = false;
    return { status: "started", runId: handle.runId };
  } catch (err) {
    if (claimHeld) {
      await runRegistry.unregister(ticketKey).catch(() => {});
    }
    throw err;
  }
}

/**
 * Counts active runs against the per-app cap, excluding claiming sentinels
 * older than STALE_CLAIM_MS. Fails closed on registry errors so a failed read
 * stalls new dispatches instead of over-allocating.
 */
async function isAtCapacity(max: number, runRegistry: RunRegistryAdapter): Promise<boolean> {
  let entries: Awaited<ReturnType<RunRegistryAdapter["listAll"]>>;
  try {
    entries = await runRegistry.listAll();
  } catch (err) {
    logger.warn({ max, error: (err as Error).message }, "plan_approved_capacity_check_failed_closed");
    return true;
  }
  const now = Date.now();
  const active = entries.filter(({ runId }) => {
    if (!isClaimingSentinel(runId)) return true;
    return now - getClaimTimestamp(runId) <= STALE_CLAIM_MS;
  }).length;
  return active >= max;
}

async function abortWorkflow(runId: string): Promise<void> {
  try {
    const run = getRun(runId);
    await run.cancel();
  } catch {}
}
