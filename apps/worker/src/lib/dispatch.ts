import { start, getRun } from "workflow/api";
import { env } from "../../env.js";
import { agentWorkflow } from "../workflows/agent.js";
import { logger } from "./logger.js";
import type { Adapters } from "./adapters.js";
import type { RunKind, RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";
import { stopTicketSandboxes } from "../sandbox/stop-ticket-sandboxes.js";
import { getDb } from "../db/client.js";
import { getEnabledWorkflowDefinitionForTrigger } from "../workflow-definition/store.js";
import {
  BUILTIN_FALLBACK_DEFINITION_VERSION,
  type AgentWorkflowInput,
} from "../workflows/agent-input.js";

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
    | "wrong_project_key"
    | "no_definition";
}

export async function dispatchTicket(
  ticketKey: string,
  adapters: Adapters,
  maxConcurrentAgents: number,
): Promise<DispatchResult> {
  const expectedProjectKey = env.JIRA_PROJECT_KEY.trim().toUpperCase();
  const expectedAiStatus = env.COLUMN_AI.trim().toLowerCase();
  const { issueTracker, runRegistry } = adapters;

  logger.info({ ticketKey, maxConcurrentAgents }, "dispatch_attempt");

  try {
    if (await runRegistry.isTicketFailed(ticketKey)) {
      logger.info({ ticketKey }, "dispatch_skipped_previously_failed");
      return { started: false, reason: "previously_failed" };
    }
  } catch (err) {
    logger.warn(
      { ticketKey, stage: "precheck_failed_marker", error: (err as Error).message },
      "dispatch_error",
    );
    return { started: false, reason: "error" };
  }

  let ticket: TicketContent | null = null;
  let workflowInput: AgentWorkflowInput | null = null;
  return claimTicketRun(ticketKey, runRegistry, maxConcurrentAgents, {
    // Runs after the claim + post-claim capacity verify, before start(): the
    // AI-column and project-key gate specific to ticket dispatch.
    postClaimGuard: async () => {
      ticket = await issueTracker.fetchTicket(ticketKey);
      const ticketStatus = ticket.trackerStatus.trim().toLowerCase();
      if (ticketStatus !== expectedAiStatus) {
        logger.info(
          { ticketKey, ticketStatus: ticket.trackerStatus, expectedStatus: env.COLUMN_AI },
          "dispatch_skipped_not_in_ai_column",
        );
        return { started: false, reason: "not_in_ai_column" };
      }
      const ticketProjectKey = extractProjectKey(ticket.identifier);
      if (!ticketProjectKey || ticketProjectKey !== expectedProjectKey) {
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
      const enabled = await getEnabledWorkflowDefinitionForTrigger(
        getDb(),
        "trigger_ticket_ai",
      );
      if (!enabled) {
        logger.info({ ticketKey }, "dispatch_skipped_no_definition");
        return { started: false, reason: "no_definition" };
      }
      workflowInput = enabled.current
        ? {
            kind: "ticket",
            ticketKey,
            definitionId: enabled.definition.id,
            definitionVersion: enabled.current.version,
          }
        : {
            kind: "ticket",
            ticketKey,
            definitionId: enabled.definition.id,
            definitionVersion: BUILTIN_FALLBACK_DEFINITION_VERSION,
          };
      return null;
    },
    startWorkflow: async () => {
      // Pass the issue key (not the numeric id) so the workflow can build
      // /browse/{KEY}?focusedCommentId=... deep links in Slack notifications.
      // Jira's REST API accepts either id or key for fetch/transition/comment.
      const handle = await start(agentWorkflow, [workflowInput!]);
      logger.info(
        { ticketId: ticket!.id, identifier: ticket!.identifier, runId: handle.runId },
        "workflow_started",
      );
      return handle.runId;
    },
  });
}

export interface ClaimTicketRunOptions {
  /**
   * Run kind persisted with the claim + registration. Defaults to 'ticket',
   * which keeps the claim/register calls two-arg so classic dispatch behaves
   * exactly as before.
   */
  kind?: RunKind;
  /**
   * Runs after the claim + post-claim capacity verify, before start(). Return
   * a DispatchResult to bail (the claim is released first) or null to proceed.
   * Throwing bails via the shared error path (claim released, reason 'error').
   */
  postClaimGuard?: () => Promise<DispatchResult | null>;
  /** Starts the workflow and returns its runId. */
  startWorkflow: () => Promise<string>;
}

/**
 * Shared claim/capacity/verify/register sequence around a workflow start.
 * Factored out of dispatchTicket so PR-trigger dispatch reuses the exact
 * concurrency fairness, claim sentinel, and post-start verification without
 * re-implementing them. Behavior for the ticket path is byte-identical.
 */
export async function claimTicketRun(
  ticketKey: string,
  runRegistry: RunRegistryAdapter,
  maxConcurrentAgents: number,
  options: ClaimTicketRunOptions,
): Promise<DispatchResult> {
  const kind = options.kind ?? "ticket";
  let stage = "precheck_capacity";
  let claimHeld = false;
  let claimValue = "";
  let startedRunId: string | null = null;
  try {
    if (await isAtCapacity(maxConcurrentAgents, runRegistry)) {
      return { started: false, reason: "at_capacity" };
    }

    stage = "claim_ticket";
    claimValue = `${CLAIMING_PREFIX}${Date.now()}`;
    const claimed =
      kind === "ticket"
        ? await runRegistry.claim(ticketKey, claimValue)
        : await runRegistry.claim(ticketKey, claimValue, kind);
    if (!claimed) {
      logger.info({ ticketKey }, "dispatch_already_claimed");
      return { started: false, reason: "already_claimed" };
    }
    claimHeld = true;

    // Post-claim capacity verify. The precheck above is not atomic with
    // claim(), so N concurrent dispatches for *different* tickets can all
    // pass the precheck and then all claim successfully — pushing the run
    // registry over the cap. Re-read the registry with our own claim
    // visible and decide fairly who stays.
    //
    // Fairness rule: sort by (claim timestamp ascending, ticketKey
    // ascending as tie-breaker); the first `max` entries win. Existing
    // non-sentinel entries (already-running workflows) are treated as
    // timestamp 0 so they always win over new claims. Every racer
    // eventually converges on the same ordering once registry writes are
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

    if (options.postClaimGuard) {
      stage = "postclaim_guard";
      const bail = await options.postClaimGuard();
      if (bail) {
        await runRegistry.unregister(ticketKey).catch(() => {});
        claimHeld = false;
        return bail;
      }
    }

    stage = "start_workflow";
    const runId = await options.startWorkflow();
    startedRunId = runId;

    stage = "verify_claim_after_start";
    const claimStillHeld = await verifyClaimNotCancelled(
      ticketKey,
      claimValue,
      runRegistry,
    );
    if (!claimStillHeld) {
      await abortWorkflow(runId, ticketKey);
      return { started: false, reason: "already_claimed" };
    }

    stage = "register_run";
    await registerRunWithRetry(runRegistry, ticketKey, runId, kind);

    return { started: true, runId };
  } catch (err) {
    if (startedRunId) {
      // The workflow started but we could not verify or register it. Abort the
      // just-started run and KEEP the claim: leaving our sentinel in place stops
      // a retry from launching a second concurrent run for the same ticket, and
      // reconcile's stale-claim sweep releases it once the horizon passes.
      await abortWorkflow(startedRunId, ticketKey);
    } else if (claimHeld) {
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
 * Idempotent register with a short retry. register() is an ON CONFLICT DO UPDATE
 * upsert on active_runs, so re-issuing it is safe; retrying a transient failure
 * avoids aborting a healthy run over a momentary registry blip. If every attempt
 * fails the caller's catch aborts the started workflow and keeps the claim so no
 * duplicate run can be dispatched.
 */
async function registerRunWithRetry(
  runRegistry: RunRegistryAdapter,
  ticketKey: string,
  runId: string,
  kind: RunKind,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (kind === "ticket") {
        await runRegistry.register(ticketKey, runId);
      } else {
        await runRegistry.register(ticketKey, runId, kind);
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Capacity check counts active runs in the Postgres registry — this is the
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
  runRegistry: RunRegistryAdapter,
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
  runRegistry: RunRegistryAdapter,
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
