import type { SettingsSnapshot } from "@shared/contracts";
import { getWorld } from "workflow/runtime";
import { logger } from "../../../infra/logger.js";
import { GateStore } from "../../../post-pr-gate/gate-store.js";
import { deleteConnectedExpiredRunObservations } from "../../../db/repositories/runs/run-observability.js";
import { reconcileConnectedPendingPrChecks } from "../../../engine/runtime/pr-external-resources.js";
import {
  getConnectedApproval,
  listConnectedApprovalParkedSubjects,
  listConnectedDispatchBlockingApprovals,
  type ApprovalRow,
} from "../../../db/repositories/approvals.js";
import { classifyConnectedProtectedClarificationSubjects } from "../../../db/repositories/clarifications.js";
import { listConnectedRecoverableManualDispatches } from "../../../db/repositories/manual-dispatch.js";
import { sweepConnectedWebhookDeliveries } from "../../../db/repositories/webhook-trigger-deliveries.js";
import { dispatchPlanApproved } from "../../approvals/index.js";
import {
  expireConnectedHookClarifications,
  retireClarificationForGoneTicket,
  resumeConnectedClarificationFromComments,
} from "../../clarifications/index.js";
import {
  dispatchTicket,
  drainOldestPendingTrigger,
  listConnectedPendingTriggers,
  sweepConnectedTriggerRateLimits,
  sweepConnectedTriggerRejectionCounters,
} from "../../dispatch/index.js";
import { reconcileAtCapacityQueue } from "../../dispatch-queue/index.js";
import type { RepositoryCatalogSnapshot } from "../../repository-catalog/index.js";
import { recoverManualDispatches } from "../../manual-dispatch/index.js";
import {
  pruneConnectedMcpAudits,
  sweepConnectedMcpIdempotencyKeys,
  sweepConnectedMcpRateLimits,
} from "../../mcp/index.js";
import type { RunsLister } from "../../overview/index.js";
import { ticketSubjectKey } from "../../../engine/support/subject-key.js";
import { reconcileRuns } from "../../run-lifecycle/index.js";
import {
  createConnectedScheduleDispatchDeps,
  runScheduleTriggerPass,
} from "../../schedule-trigger/index.js";
import { maxConcurrentAgents, ticketBoardSettings } from "../../settings/index.js";
import {
  collectConnectedSnapshots,
} from "../../telemetry/index.js";
import {
  sweepConnectedOrphanedAwaitingRuns,
  sweepConnectedOrphanedRunningRuns,
  upsertConnectedRunSnapshots,
} from "../../../db/repositories/runs/telemetry.js";
import { createAdapters } from "../../../engine/support/adapters.js";
import {
  redispatchPendingWebhookDeliveries,
  sweepConnectedWebhookRateLimits,
  sweepConnectedWebhookRejectionCounters,
} from "../../webhook-trigger/index.js";
import { createConnectedWebhookDispatchDeps } from "../custom-webhooks/dispatch-deps.js";

/**
 * One pass of the scheduled poller.
 *
 * The cron route above this owns nothing but the shared-secret check and the
 * JSON answer: discovery, dispatch, recovery, reconciliation and every
 * housekeeping sweep are decided here, so the ordering between them is testable
 * without a server runtime. Every housekeeping phase is best-effort by design,
 * because one failing sweep must never strand the phases behind it.
 */

const PENDING_TRIGGER_RECOVERY_SCAN_LIMIT = 20;

export async function runPollPass(
  settings: SettingsSnapshot,
  loadRepositoryCatalog: () => Promise<RepositoryCatalogSnapshot>,
) {
  const board = ticketBoardSettings(settings);
  const adapters = createAdapters();
  const clarificationExpiry = await expireConnectedHookClarifications();

  /**
   * The catalog, once per tick, and only for the phases that dispatch.
   *
   * A thunk rather than a value for the same reason the webhook ingresses take
   * one: this pass is also the deployment's housekeeping, and clarification
   * expiry, the at-capacity queue, claim release, the rate sweeps and the stall
   * backstop have no dispatch decision to make. A catalog read that fails must
   * cost the dispatch phases and nothing else, so the failure is caught here and
   * every phase that needs a snapshot asks for one and skips itself without it.
   * Memoised by the route, so this is one query however many phases ask.
   */
  let catalogFailed = false;
  const repositoryCatalogOrNull = async (
    phase: string,
  ): Promise<RepositoryCatalogSnapshot | null> => {
    if (catalogFailed) return null;
    try {
      return await loadRepositoryCatalog();
    } catch (error) {
      catalogFailed = true;
      logger.warn(
        { phase, error: error instanceof Error ? error.message : String(error) },
        "poll_repository_catalog_load_failed",
      );
      return null;
    }
  };

  const clarificationProtection =
    await classifyConnectedProtectedClarificationSubjects();
  const protectedClarificationSubjects = new Set(clarificationProtection.all);
  // Subjects reconciled by terminal cleanup only: their run is finished and its
  // bound claim must be released quietly, never through the orphan cancellation
  // cascade. Clarification successors and approval parks share that shape.
  const terminalReconciliationSubjects = new Set(
    clarificationProtection.terminal,
  );
  const retainedClarificationSubjects = new Set(
    clarificationProtection.retained,
  );

  // A persisted approval owns the ticket's next path. Protect both pending
  // decisions and approved-undispatched continuations for the entire poll
  // snapshot. Recovery runs after owner reconciliation below, so an exact
  // reserved owner retained for Jira settlement can be cleared before retry.
  const blockingApprovals = await listConnectedDispatchBlockingApprovals();
  const protectedDiscoverySubjects = new Set(protectedClarificationSubjects);
  for (const approval of blockingApprovals) {
    protectedDiscoverySubjects.add(ticketSubjectKey("jira", approval.ticketKey));
  }

  // The run that filed a plan ended when it parked the ticket outside the AI
  // column, so its bound claim is terminal bookkeeping, not an orphan. Cancelling
  // it retires the pending approval and strands the ticket with nobody able to
  // approve; terminal cleanup releases the same claim quietly, which is what the
  // approval dispatch needs to reserve.
  for (const subjectKey of await listConnectedApprovalParkedSubjects()) {
    terminalReconciliationSubjects.add(subjectKey);
  }

  // Durable clarification recovery owns its subject before generic AI-column
  // discovery. Even when capacity prevents a missing successor reservation
  // from being recreated on this tick, the answered checkpoint remains
  // protected and cannot be replaced by a fresh ticket workflow.
  const ticketKeys = await discoverAiColumnTickets(adapters, board);

  const manualDispatchCatalog = await repositoryCatalogOrNull("manual_dispatch_recovery");
  const manualDispatchRecovery = manualDispatchCatalog
    ? await recoverManualDispatches({
        adapters,
        maxConcurrentAgents: maxConcurrentAgents(settings),
        repositoryCatalog: manualDispatchCatalog,
      })
    : { scanned: 0, started: 0, recovering: 0, failed: 0 };
  const protectedRunSubjects = new Set(retainedClarificationSubjects);
  for (const request of await listConnectedRecoverableManualDispatches()) {
    protectedRunSubjects.add(request.subjectKey);
  }

  const releasedTriggerRecovery = { attempted: 0, started: 0, errors: 0 };
  const releasedTriggerSubjects = new Set<string>();
  const { cancelled, cleaned } = await reconcileRuns(
    new Set(ticketKeys),
    adapters.runRegistry,
    adapters.issueTracker,
    async (ticketKey, reason) => {
      const detail =
        reason === "inflight_claim"
          ? "claim was cleared after the ticket left AI"
          : "workflow run was cancelled after the ticket left AI";
      await adapters.messaging.notifyForTicket(ticketKey, {
        kind: "canceled",
        reason: `${detail}.`,
      });
    },
    async (subjectKey) => {
      releasedTriggerSubjects.add(subjectKey);
      if (releasedTriggerRecovery.started > 0) return;
      // The claim release around this callback is housekeeping and has already
      // happened; only the successor it could start needs the catalog.
      const drainCatalog = await repositoryCatalogOrNull("released_trigger_drain");
      if (!drainCatalog) return;
      releasedTriggerRecovery.attempted++;
      try {
        const result = await drainOldestPendingTrigger(subjectKey, {
          runRegistry: adapters.runRegistry,
          maxConcurrentAgents: maxConcurrentAgents(settings),
          repositoryCatalog: drainCatalog,
        });
        if (result?.result === "started") releasedTriggerRecovery.started++;
        if (result?.result === "error") releasedTriggerRecovery.errors++;
      } catch (error) {
        releasedTriggerRecovery.errors++;
        throw error;
      }
    },
    protectedRunSubjects,
    undefined,
    terminalReconciliationSubjects,
    retireClarificationForGoneTicket,
  );

  const polledTriggerRecovery = await recoverPendingTriggers(
    adapters,
    releasedTriggerSubjects,
    releasedTriggerRecovery.started === 0,
    settings,
    await repositoryCatalogOrNull("pending_trigger_recovery"),
  );
  const approvalRecovery = await recoverApprovedPlanDispatches(
    blockingApprovals,
    adapters,
    settings,
  );
  const dispatchOutcome = await dispatchDiscoveredTickets(
    ticketKeys,
    adapters,
    protectedDiscoverySubjects,
    settings,
  );
  const started = dispatchOutcome.started;

  // Surface every at-capacity refusal on the ticket: queue each refused ticket
  // and post a Jira comment per at-capacity episode (at-least-once, effectively
  // once; retried on Jira failure; row dropped when the ticket dispatches or
  // leaves the AI column). Best-effort — a failed queue pass must not fail the
  // poll.
  const atCapacityQueue = await reconcileAtCapacityQueue({
    issueTracker: adapters.issueTracker,
    atCapacityKeys: dispatchOutcome.atCapacity,
    startedKeys: dispatchOutcome.started,
    currentTicketKeys: ticketKeys,
  }).catch((err) => {
    logger.warn(
      { err: (err as Error).message },
      "poll_at_capacity_queue_failed",
    );
    return { queued: 0, commented: 0 };
  });

  // Housekeeping: physically drop expired gate rows (reads already treat
  // them as absent). Best-effort — a failed purge must not fail the poll.
  await new GateStore()
    .purgeExpired()
    .catch((err) => logger.warn({ err: (err as Error).message }, "poll_gate_purge_failed"));

  // Replay retention: delete at most one bounded batch per poll. The durable
  // expiry markers remain on workflow_runs, so the UI can still distinguish an
  // expired replay from a historical run that was never captured.
  const replayRetention = await deleteConnectedExpiredRunObservations({ limit: 100 })
    .catch((err) => {
      logger.warn(
        { err: (err as Error).message },
        "poll_replay_retention_failed",
      );
      return { deleted: 0, runIds: [] };
    });
  // Webhook deliveries that could not start when they arrived (busy subject, no
  // capacity, a failed start) stay pending, so this is what actually starts
  // them; the two sweeps drop counter rows whose window nothing can read again.
  // Best-effort, like every other housekeeping step in this poll.
  const webhookRecovery = await recoverPendingWebhookDeliveries(adapters, settings);
  await sweepConnectedWebhookRateLimits().catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_webhook_rate_sweep_failed"),
  );
  await sweepConnectedWebhookRejectionCounters().catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_webhook_rejection_sweep_failed"),
  );
  await sweepConnectedWebhookDeliveries().catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_webhook_delivery_sweep_failed"),
  );
  // The same housekeeping for the per-node trigger limits, which every automatic
  // trigger type writes: windows nothing can count into again, and rejection days
  // nothing surfaces anymore.
  const now = new Date();
  await sweepConnectedTriggerRateLimits(now).catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_trigger_rate_sweep_failed"),
  );
  await sweepConnectedTriggerRejectionCounters(now).catch((err) =>
    logger.warn(
      { err: (err as Error).message },
      "poll_trigger_rejection_sweep_failed",
    ),
  );
  // Rate limit windows are unreadable two minutes after they open, and nothing
  // else ever deletes them.
  await sweepConnectedMcpRateLimits().catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_mcp_rate_sweep_failed"),
  );

  // Nothing external delivers a schedule occurrence, so this pass is the whole
  // trigger: it evaluates every live schedule against its cron, dispatches what is
  // due, starts what could not start earlier, and sweeps its own ledger. Bounded
  // per tick and best-effort, like every other housekeeping phase here.
  const scheduleTriggers = await evaluateScheduleTriggers(adapters, settings);

  const prCheckReconciliation = await reconcileConnectedPendingPrChecks().catch(
    (err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "poll_pr_check_reconciliation_failed",
      );
      return { attempted: 0, closed: 0, pending: 0 };
    },
  );

  // Telemetry: snapshot run lifecycle from the Workflow world into Neon so run
  // history, active counts and durations stay SQL-queryable beyond Vercel's
  // ~24h observability window. Per-run cost is filled separately by the agent
  // workflow. Best-effort — a failed snapshot must not fail the poll.
  try {
    const snapshots = await collectConnectedSnapshots({
      runsLister: getWorld().runs as RunsLister,
    });
    await upsertConnectedRunSnapshots(snapshots);
    // The snapshot above deliberately never downgrades "awaiting", so a park
    // marker left behind by a best-effort writer that failed is invisible to it.
    // This settles those orphans.
    await sweepConnectedOrphanedAwaitingRuns();
    await sweepConnectedOrphanedRunningRuns();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "poll_snapshot_failed");
  }

  // MCP audit retention, last so that no earlier failure can strand it: the
  // steps above include live Jira calls that throw, and retention that only
  // runs when the rest of the poll is healthy silently stops running at all.
  // Reported like replay retention, so a sweep that never fires is visible.
  const mcpAuditRetention = await pruneConnectedMcpAudits(new Date(), {
    settings,
    limit: 100,
  }).catch(
    (err) => {
      logger.warn({ err: (err as Error).message }, "poll_mcp_audit_prune_failed");
      return { deleted: 0 };
    },
  );

  // Same story for spent idempotency keys: taking one over replaces a row, it
  // never removes one, so this is the only thing that ever deletes them.
  const mcpIdempotencyRetention = await sweepConnectedMcpIdempotencyKeys(new Date(), {
    limit: 100,
  }).catch((err) => {
    logger.warn({ err: (err as Error).message }, "poll_mcp_idempotency_sweep_failed");
    return { deleted: 0 };
  });

  return {
    status: "ok",
    discovered: ticketKeys.length,
    started: started.length,
    atCapacityQueue,
    cancelled,
    cleaned,
    pendingRecovered:
      releasedTriggerRecovery.started + polledTriggerRecovery.started,
    triggerRecovery: {
      released: releasedTriggerRecovery,
      polled: polledTriggerRecovery,
    },
    clarificationExpiry,
    approvalRecovery,
    manualDispatchRecovery,
    webhookRecovery,
    scheduleTriggers,
    replayRetention: { deleted: replayRetention.deleted },
    mcpAuditRetention: { deleted: mcpAuditRetention.deleted },
    mcpIdempotencyRetention: { deleted: mcpIdempotencyRetention.deleted },
    prCheckReconciliation,
  };
}

async function evaluateScheduleTriggers(
  adapters: ReturnType<typeof createAdapters>,
  settings: SettingsSnapshot,
): Promise<ReturnType<typeof runScheduleTriggerPass>> {
  return await runScheduleTriggerPass(
    createConnectedScheduleDispatchDeps(
      adapters.runRegistry,
      maxConcurrentAgents(settings),
    ),
  ).catch((error) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "poll_schedule_trigger_pass_failed",
    );
    return {
      evaluation: {
        evaluated: 0,
        revoked: 0,
        invalid: 0,
        due: 0,
        started: 0,
        skipped: 0,
        deferred: 0,
        errors: 0,
      },
      drain: {
        listed: 0,
        started: 0,
        revoked: 0,
        deferred: 0,
        pastGrace: 0,
        errors: 0,
      },
      expired: 0,
      failures: 1,
    };
  });
}

async function recoverPendingWebhookDeliveries(
  adapters: ReturnType<typeof createAdapters>,
  settings: SettingsSnapshot,
): Promise<{ attempted: number; started: number; errors: number }> {
  try {
    const results = await redispatchPendingWebhookDeliveries(
      createConnectedWebhookDispatchDeps(adapters.runRegistry, settings),
    );
    return {
      attempted: results.length,
      started: results.filter((result) => result.result === "started").length,
      errors: results.filter((result) => result.result === "error").length,
    };
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "poll_webhook_delivery_recovery_failed",
    );
    return { attempted: 0, started: 0, errors: 1 };
  }
}

async function recoverPendingTriggers(
  adapters: ReturnType<typeof createAdapters>,
  releasedSubjects: ReadonlySet<string>,
  mayStart: boolean,
  settings: SettingsSnapshot,
  repositoryCatalog: RepositoryCatalogSnapshot | null,
): Promise<{ listed: number; attempted: number; started: number; errors: number }> {
  const metrics = { listed: 0, attempted: 0, started: 0, errors: 0 };
  if (!mayStart || !repositoryCatalog) return metrics;

  let pending: Awaited<ReturnType<typeof listConnectedPendingTriggers>>;
  try {
    pending = await listConnectedPendingTriggers(PENDING_TRIGGER_RECOVERY_SCAN_LIMIT);
    metrics.listed = pending.length;
  } catch (error) {
    metrics.errors++;
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "poll_pending_trigger_list_failed",
    );
    return metrics;
  }

  for (const trigger of pending) {
    if (releasedSubjects.has(trigger.subjectKey)) continue;
    metrics.attempted++;
    try {
      const result = await drainOldestPendingTrigger(trigger.subjectKey, {
        runRegistry: adapters.runRegistry,
        maxConcurrentAgents: maxConcurrentAgents(settings),
        repositoryCatalog,
      });
      if (result?.result === "error") metrics.errors++;
      if (result?.result === "started") {
        metrics.started++;
        break;
      }
    } catch (error) {
      metrics.errors++;
      logger.warn(
        {
          subjectKey: trigger.subjectKey,
          error: error instanceof Error ? error.message : String(error),
        },
        "poll_pending_trigger_recovery_failed",
      );
    }
  }

  return metrics;
}

async function recoverApprovedPlanDispatches(
  blockingApprovals: ApprovalRow[],
  adapters: ReturnType<typeof createAdapters>,
  settings: SettingsSnapshot,
): Promise<{ scanned: number; started: number; blocked: number; errors: number }> {
  const approved = blockingApprovals.filter(
    (row) => row.status === "approved" && row.dispatchedRunId === null,
  );
  const metrics = { scanned: approved.length, started: 0, blocked: 0, errors: 0 };

  await Promise.all(
    approved.map(async (approval) => {
      try {
        const result = await dispatchPlanApproved({
          runRegistry: adapters.runRegistry,
          issueTracker: adapters.issueTracker,
          approval,
          actor: {
            id: approval.decidedById ?? "system",
            label: approval.decidedByLabel ?? "system",
          },
          maxConcurrentAgents: maxConcurrentAgents(settings),
          onClaimed: async () => {
            const fresh = await getConnectedApproval(approval.id);
            if (
              !fresh ||
              fresh.status !== "approved" ||
              fresh.dispatchedRunId !== null
            ) {
              throw new Error(`approval ${approval.id} is no longer dispatchable`);
            }
          },
        });
        if (result.status === "started") metrics.started++;
        else metrics.blocked++;
      } catch (error) {
        metrics.errors++;
        logger.warn(
          {
            approvalId: approval.id,
            ticketKey: approval.ticketKey,
            error: error instanceof Error ? error.message : String(error),
          },
          "poll_approval_recovery_failed",
        );
      }
    }),
  );

  return metrics;
}

async function discoverAiColumnTickets(
  adapters: ReturnType<typeof createAdapters>,
  board: ReturnType<typeof ticketBoardSettings>,
): Promise<string[]> {
  // Deterministic ORDER BY so the (capped, unpaginated) page is STABLE across
  // ticks: without it, when the AI column holds more than the maxResults page,
  // a still-queued ticket can rotate out of one tick's page and back into the
  // next, and the at-capacity reconcile would delete then re-insert its row,
  // producing a duplicate "waiting for capacity" comment on the same episode.
  const jql = `project = "${board.projectKey}" AND status = "${board.aiColumn}" ORDER BY created ASC`;
  const ticketKeys = await adapters.issueTracker.searchTickets(jql);
  const normalizedKeys = normalizeTicketKeys(ticketKeys, board);

  if (normalizedKeys.length !== ticketKeys.length) {
    logger.warn(
      {
        discovered: ticketKeys.length,
        valid: normalizedKeys.length,
        expectedProjectKey: board.projectKey,
      },
      "poll_discarded_invalid_ticket_keys",
    );
  }

  logger.info({ ticketCount: normalizedKeys.length }, "poll_discovered_tickets");
  return normalizedKeys;
}

interface DispatchOutcome {
  /** Ticket keys whose workflow actually started this tick. */
  started: string[];
  /** Ticket keys refused because every run slot was taken. */
  atCapacity: string[];
}

async function dispatchDiscoveredTickets(
  ticketKeys: string[],
  adapters: ReturnType<typeof createAdapters>,
  protectedSubjects: ReadonlySet<string>,
  settings: SettingsSnapshot,
): Promise<DispatchOutcome> {
  // Dispatch in parallel. dispatchTicket is internally atomic — the
  // post-claim fairness check in src/services/dispatch/dispatch.ts caps started
  // workflows at MAX_CONCURRENT_AGENTS even when racers run concurrently,
  // so excess parallel dispatches safely return `at_capacity`.
  const results = await Promise.all(
    ticketKeys.map(async (key) => {
      if (protectedSubjects.has(ticketSubjectKey("jira", key))) {
        // A protected subject may hold a suspended clarification run whose
        // answers arrived as human comments. Try to wake it (no nudging on the
        // poll: the cron JQL snapshot is not the human's commit gesture). A
        // resumed run needs no dispatch, so this always returns started:false.
        const resume = await resumeConnectedClarificationFromComments({
          issueTracker: adapters.issueTracker,
          ticketKey: key,
          allowNudge: false,
        }).catch((err) => {
          logger.warn(
            { ticketKey: key, error: (err as Error).message },
            "poll_clarification_resume_failed",
          );
          return null;
        });
        if (resume && resume.status !== "no_clarification") {
          logger.info(
            { ticketKey: key, resumeStatus: resume.status, runId: resume.runId },
            "poll_clarification_resume",
          );
        }
        // Protected subjects are not refusals — they are deliberately deferred,
        // so they carry no dispatch reason to log.
        return { key, started: false, reason: undefined as string | undefined };
      }
      try {
        const result = await dispatchTicket(
          key,
          adapters,
          maxConcurrentAgents(settings),
        );
        if (!result.started) {
          // Every refusal used to vanish here; log one structured line per
          // non-started dispatch so a full pool (and every other silent reason)
          // is visible in the poll's logs.
          logger.info(
            { ticketKey: key, reason: result.reason },
            "poll_dispatch_refused",
          );
        }
        return { key, started: result.started, reason: result.reason };
      } catch (err) {
        logger.warn({ ticketKey: key, error: err }, "poll_dispatch_failed");
        return { key, started: false, reason: "error" as string | undefined };
      }
    }),
  );

  return {
    started: results.filter((r) => r.started).map((r) => r.key),
    atCapacity: results
      .filter((r) => r.reason === "at_capacity")
      .map((r) => r.key),
  };
}

function normalizeTicketKeys(
  ticketKeys: string[],
  board: ReturnType<typeof ticketBoardSettings>,
): string[] {
  const expectedPrefix = `${board.projectKey.trim().toUpperCase()}-`;
  const unique = new Set<string>();

  for (const rawKey of ticketKeys) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) continue;
    const normalizedKey = key.toUpperCase();
    if (!normalizedKey.startsWith(expectedPrefix)) continue;
    unique.add(normalizedKey);
  }

  return [...unique];
}
