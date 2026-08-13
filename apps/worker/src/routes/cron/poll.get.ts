import { defineEventHandler, getHeader, createError } from "h3";
import { getWorld } from "workflow/runtime";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { countCapacityConsumers, dispatchTicket } from "../../lib/dispatch.js";
import {
  commentOnQueuedTickets,
  syncCapacityNotices,
} from "../../lib/dispatch-capacity.js";
import { reconcileRuns } from "../../lib/reconcile.js";
import { logger } from "../../lib/logger.js";
import { GateStore } from "../../post-pr-gate/gate-store.js";
import { getDb } from "../../db/client.js";
import { collectSnapshots } from "../../lib/telemetry/collect-snapshots.js";
import {
  sweepOrphanedAwaitingRuns,
  sweepOrphanedRunningRuns,
  upsertRunSnapshots,
} from "../../lib/telemetry/run-telemetry.js";
import type { RunsLister } from "../../lib/overview/collect-runs.js";
import { drainOldestPendingTrigger } from "../../lib/dispatch-trigger.js";
import { listPendingTriggers } from "../../lib/trigger-delivery-store.js";
import {
  classifyProtectedClarificationSubjects,
} from "../../clarifications/store.js";
import { retireParksForDeletedTickets } from "../../clarifications/deleted-ticket-sweep.js";
import { retryStalledResumes } from "../../clarifications/stalled-resume-sweep.js";
import { resumeClarificationFromComments } from "../../clarifications/resume-from-comments.js";
import { ticketSubjectKey } from "../../lib/subject-key.js";
import { expireHookClarifications } from "../../clarifications/expiry.js";
import { dispatchPlanApproved } from "../../approvals/dispatch.js";
import {
  getApproval,
  listApprovalParkedSubjects,
  listDispatchBlockingApprovals,
  type ApprovalRow,
} from "../../approvals/store.js";
import { deleteExpiredRunObservations } from "../../run-observability/store.js";
import { recoverManualDispatches } from "../../manual-dispatch/service.js";
import { listRecoverableManualDispatches } from "../../manual-dispatch/store.js";
import { sweepWebhookDeliveries } from "../../webhook-trigger/delivery-store.js";
import { redispatchPendingWebhookDeliveries } from "../../webhook-trigger/dispatch-webhook-trigger.js";
import { sweepWebhookRateLimits } from "../../webhook-trigger/rate-limit.js";
import { sweepWebhookRejectionCounters } from "../../webhook-trigger/rejection-counters.js";
import { pruneMcpAudits } from "../../mcp/audit-store.js";
import { sweepMcpIdempotencyKeys } from "../../mcp/idempotency-store.js";
import { sweepMcpRateLimits } from "../../mcp/rate-limit-store.js";
import {
  sweepTriggerRateLimits,
  sweepTriggerRejectionCounters,
} from "../../lib/trigger-rate-limit.js";
import {
  createScheduleDispatchDeps,
  runScheduleTriggerPass,
} from "../../schedule-trigger/dispatch-schedule-trigger.js";
import { reconcilePendingPrChecks } from "../../workflows/pr-external-resources.js";
import { createWebhookDispatchDeps } from "../webhooks/custom/[endpointId].post.js";

const PENDING_TRIGGER_RECOVERY_SCAN_LIMIT = 20;

export default defineEventHandler(async (event) => {
  verifyCronAuth(getHeader(event, "authorization"));

  const adapters = createAdapters();
  const db = getDb();
  const clarificationExpiry = await expireHookClarifications(db);

  const clarificationProtection =
    await classifyProtectedClarificationSubjects(db);
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
  const blockingApprovals = await listDispatchBlockingApprovals(db);
  const protectedDiscoverySubjects = new Set(protectedClarificationSubjects);
  for (const approval of blockingApprovals) {
    protectedDiscoverySubjects.add(ticketSubjectKey("jira", approval.ticketKey));
  }

  // The run that filed a plan ended when it parked the ticket outside the AI
  // column, so its bound claim is terminal bookkeeping, not an orphan. Cancelling
  // it retires the pending approval and strands the ticket with nobody able to
  // approve; terminal cleanup releases the same claim quietly, which is what the
  // approval dispatch needs to reserve.
  for (const subjectKey of await listApprovalParkedSubjects(db)) {
    terminalReconciliationSubjects.add(subjectKey);
  }

  // Durable clarification recovery owns its subject before generic AI-column
  // discovery. Even when capacity prevents a missing successor reservation
  // from being recreated on this tick, the answered checkpoint remains
  // protected and cannot be replaced by a fresh ticket workflow.
  const ticketKeys = await discoverAiColumnTickets(adapters);

  const manualDispatchRecovery = await recoverManualDispatches({
    db,
    adapters,
    maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
  });
  const protectedRunSubjects = new Set(retainedClarificationSubjects);
  for (const request of await listRecoverableManualDispatches(db)) {
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
      releasedTriggerRecovery.attempted++;
      try {
        const result = await drainOldestPendingTrigger(subjectKey, {
          db,
          runRegistry: adapters.runRegistry,
          maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
        });
        if (result?.result === "started") releasedTriggerRecovery.started++;
        if (result?.result === "error") releasedTriggerRecovery.errors++;
      } catch (error) {
        releasedTriggerRecovery.errors++;
        throw error;
      }
    },
    protectedRunSubjects,
    db,
    terminalReconciliationSubjects,
  );

  const polledTriggerRecovery = await recoverPendingTriggers(
    db,
    adapters,
    releasedTriggerSubjects,
    releasedTriggerRecovery.started === 0,
  );
  const approvalRecovery = await recoverApprovedPlanDispatches(
    blockingApprovals,
    db,
    adapters,
  );
  // Ahead of dispatch on purpose: a park whose ticket was deleted holds a
  // concurrency slot that nothing else ever gives back, and retiring it here
  // means the ticket waiting for that slot starts on this same tick instead of
  // the next one. Best-effort, like every other sweep in this poll.
  const deletedTicketParks = await retireParksForDeletedTickets({
    db,
    runRegistry: adapters.runRegistry,
    issueTracker: adapters.issueTracker,
  }).catch((err) => {
    logger.warn(
      { err: (err as Error).message },
      "poll_deleted_ticket_park_sweep_failed",
    );
    return { observed: 0, retired: 0 };
  });

  // Same reason, one state later: an answer that was recorded but never woke its
  // run leaves the same occupied slot, and the paths that retry it only reach a
  // ticket sitting in the AI column.
  const stalledResumes = await retryStalledResumes({
    db,
    runRegistry: adapters.runRegistry,
    issueTracker: adapters.issueTracker,
  }).catch((err) => {
    logger.warn({ err: (err as Error).message }, "poll_stalled_resume_sweep_failed");
    return { attempted: 0, resumed: 0, retired: 0 };
  });

  const dispatched = await dispatchDiscoveredTickets(
    ticketKeys,
    adapters,
    protectedDiscoverySubjects,
    db,
  );
  const started = dispatched.started;

  // The queue a person can see. Recorded here rather than derived on read: this
  // is what the dispatch actually refused, and the row is also what stops the
  // ticket being commented on again every minute. Best-effort, like every other
  // ledger in this poll.
  const queueLedger = await (async () => {
    await syncCapacityNotices(db, {
      refused: dispatched.refusedAtCapacity.map((ticketKey) => ({
        subjectKey: ticketSubjectKey("jira", ticketKey),
        ticketKey,
      })),
      liveTicketKeys: ticketKeys.filter((key) => !started.includes(key)),
    });
    const notified = await commentOnQueuedTickets(db, adapters.issueTracker, {
      limit: env.MAX_CONCURRENT_AGENTS,
      occupied: await countCapacityConsumers(adapters.runRegistry),
    });
    return { queued: dispatched.refusedAtCapacity.length, notified };
  })().catch((err) => {
    logger.warn({ err: (err as Error).message }, "poll_capacity_queue_failed");
    return { queued: dispatched.refusedAtCapacity.length, notified: 0 };
  });

  // Housekeeping: physically drop expired gate rows (reads already treat
  // them as absent). Best-effort — a failed purge must not fail the poll.
  await new GateStore(db)
    .purgeExpired()
    .catch((err) => logger.warn({ err: (err as Error).message }, "poll_gate_purge_failed"));

  // Replay retention: delete at most one bounded batch per poll. The durable
  // expiry markers remain on workflow_runs, so the UI can still distinguish an
  // expired replay from a historical run that was never captured.
  const replayRetention = await deleteExpiredRunObservations({ db, limit: 100 })
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
  const webhookRecovery = await recoverPendingWebhookDeliveries(db, adapters);
  await sweepWebhookRateLimits(db).catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_webhook_rate_sweep_failed"),
  );
  await sweepWebhookRejectionCounters(db).catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_webhook_rejection_sweep_failed"),
  );
  await sweepWebhookDeliveries(db).catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_webhook_delivery_sweep_failed"),
  );
  // The same housekeeping for the per-node trigger limits, which every automatic
  // trigger type writes: windows nothing can count into again, and rejection days
  // nothing surfaces anymore.
  const now = new Date();
  await sweepTriggerRateLimits(db, now).catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_trigger_rate_sweep_failed"),
  );
  await sweepTriggerRejectionCounters(db, now).catch((err) =>
    logger.warn(
      { err: (err as Error).message },
      "poll_trigger_rejection_sweep_failed",
    ),
  );
  // Rate limit windows are unreadable two minutes after they open, and nothing
  // else ever deletes them.
  await sweepMcpRateLimits(db).catch((err) =>
    logger.warn({ err: (err as Error).message }, "poll_mcp_rate_sweep_failed"),
  );

  // Nothing external delivers a schedule occurrence, so this pass is the whole
  // trigger: it evaluates every live schedule against its cron, dispatches what is
  // due, starts what could not start earlier, and sweeps its own ledger. Bounded
  // per tick and best-effort, like every other housekeeping phase here.
  const scheduleTriggers = await evaluateScheduleTriggers(db, adapters);

  const prCheckReconciliation = await reconcilePendingPrChecks(db).catch(
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
    const snapshots = await collectSnapshots({
      runsLister: getWorld().runs as RunsLister,
      db,
    });
    await upsertRunSnapshots(db, snapshots);
    // The snapshot above deliberately never downgrades "awaiting", so a park
    // marker left behind by a best-effort writer that failed is invisible to it.
    // This settles those orphans.
    await sweepOrphanedAwaitingRuns(db);
    await sweepOrphanedRunningRuns(db);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "poll_snapshot_failed");
  }

  // MCP audit retention, last so that no earlier failure can strand it: the
  // steps above include live Jira calls that throw, and retention that only
  // runs when the rest of the poll is healthy silently stops running at all.
  // Reported like replay retention, so a sweep that never fires is visible.
  const mcpAuditRetention = await pruneMcpAudits(db, new Date(), { limit: 100 }).catch(
    (err) => {
      logger.warn({ err: (err as Error).message }, "poll_mcp_audit_prune_failed");
      return { deleted: 0 };
    },
  );

  // Same story for spent idempotency keys: taking one over replaces a row, it
  // never removes one, so this is the only thing that ever deletes them.
  const mcpIdempotencyRetention = await sweepMcpIdempotencyKeys(db, new Date(), {
    limit: 100,
  }).catch((err) => {
    logger.warn({ err: (err as Error).message }, "poll_mcp_idempotency_sweep_failed");
    return { deleted: 0 };
  });

  return {
    status: "ok",
    discovered: ticketKeys.length,
    started: started.length,
    cancelled,
    cleaned,
    pendingRecovered:
      releasedTriggerRecovery.started + polledTriggerRecovery.started,
    triggerRecovery: {
      released: releasedTriggerRecovery,
      polled: polledTriggerRecovery,
    },
    clarificationExpiry,
    deletedTicketParks,
    stalledResumes,
    queueLedger,
    approvalRecovery,
    manualDispatchRecovery,
    webhookRecovery,
    scheduleTriggers,
    replayRetention: { deleted: replayRetention.deleted },
    mcpAuditRetention: { deleted: mcpAuditRetention.deleted },
    mcpIdempotencyRetention: { deleted: mcpIdempotencyRetention.deleted },
    prCheckReconciliation,
  };
});

async function evaluateScheduleTriggers(
  db: ReturnType<typeof getDb>,
  adapters: ReturnType<typeof createAdapters>,
): Promise<ReturnType<typeof runScheduleTriggerPass>> {
  return await runScheduleTriggerPass(
    createScheduleDispatchDeps(
      db,
      adapters.runRegistry,
      env.MAX_CONCURRENT_AGENTS,
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
  db: ReturnType<typeof getDb>,
  adapters: ReturnType<typeof createAdapters>,
): Promise<{ attempted: number; started: number; errors: number }> {
  try {
    const results = await redispatchPendingWebhookDeliveries(
      createWebhookDispatchDeps(db, adapters.runRegistry),
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
  db: ReturnType<typeof getDb>,
  adapters: ReturnType<typeof createAdapters>,
  releasedSubjects: ReadonlySet<string>,
  mayStart: boolean,
): Promise<{ listed: number; attempted: number; started: number; errors: number }> {
  const metrics = { listed: 0, attempted: 0, started: 0, errors: 0 };
  if (!mayStart) return metrics;

  let pending: Awaited<ReturnType<typeof listPendingTriggers>>;
  try {
    pending = await listPendingTriggers(
      db,
      PENDING_TRIGGER_RECOVERY_SCAN_LIMIT,
    );
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
        db,
        runRegistry: adapters.runRegistry,
        maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
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
  db: ReturnType<typeof getDb>,
  adapters: ReturnType<typeof createAdapters>,
): Promise<{ scanned: number; started: number; blocked: number; errors: number }> {
  const approved = blockingApprovals.filter(
    (row) => row.status === "approved" && row.dispatchedRunId === null,
  );
  const metrics = { scanned: approved.length, started: 0, blocked: 0, errors: 0 };

  await Promise.all(
    approved.map(async (approval) => {
      try {
        const result = await dispatchPlanApproved({
          db,
          runRegistry: adapters.runRegistry,
          issueTracker: adapters.issueTracker,
          approval,
          actor: {
            id: approval.decidedById ?? "system",
            label: approval.decidedByLabel ?? "system",
          },
          maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
          onClaimed: async () => {
            const fresh = await getApproval(db, approval.id);
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

function verifyCronAuth(authHeader: string | undefined): void {
  if (!env.CRON_SECRET) return;
  if (authHeader === `Bearer ${env.CRON_SECRET}`) return;

  throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
}

async function discoverAiColumnTickets(
  adapters: ReturnType<typeof createAdapters>,
): Promise<string[]> {
  const jql = `project = "${env.JIRA_PROJECT_KEY}" AND status = "${env.COLUMN_AI}"`;
  const ticketKeys = await adapters.issueTracker.searchTickets(jql);
  const normalizedKeys = normalizeTicketKeys(ticketKeys);

  if (normalizedKeys.length !== ticketKeys.length) {
    logger.warn(
      {
        discovered: ticketKeys.length,
        valid: normalizedKeys.length,
        expectedProjectKey: env.JIRA_PROJECT_KEY,
      },
      "poll_discarded_invalid_ticket_keys",
    );
  }

  logger.info({ ticketCount: normalizedKeys.length }, "poll_discovered_tickets");
  return normalizedKeys;
}

async function dispatchDiscoveredTickets(
  ticketKeys: string[],
  adapters: ReturnType<typeof createAdapters>,
  protectedSubjects: ReadonlySet<string>,
  db: ReturnType<typeof getDb>,
): Promise<{ started: string[]; refusedAtCapacity: string[] }> {
  // Dispatch in parallel. dispatchTicket is internally atomic — the
  // post-claim fairness check in src/lib/dispatch.ts caps started
  // workflows at MAX_CONCURRENT_AGENTS even when racers run concurrently,
  // so excess parallel dispatches safely return `at_capacity`.
  const results = await Promise.all(
    ticketKeys.map(async (key) => {
      if (protectedSubjects.has(ticketSubjectKey("jira", key))) {
        // A protected subject may hold a suspended clarification run whose
        // answers arrived as human comments. Try to wake it (no nudging on the
        // poll: the cron JQL snapshot is not the human's commit gesture). A
        // resumed run needs no dispatch, so this always returns started:false.
        const resume = await resumeClarificationFromComments({
          db,
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
        return { key, started: false };
      }
      try {
        const result = await dispatchTicket(
          key,
          adapters,
          env.MAX_CONCURRENT_AGENTS,
        );
        if (!result.started) {
          // The refusal reasons are otherwise invisible: dispatchTicket returns
          // at_capacity/already_claimed/previously_failed/approval_pending
          // without logging, so a full pool is indistinguishable from a dead
          // cron. The webhook path already logs its own dispatch_result.
          logger.info(
            { ticketKey: key, reason: result.reason },
            "poll_dispatch_refused",
          );
        }
        return { key, started: result.started, reason: result.reason };
      } catch (err) {
        logger.warn({ ticketKey: key, error: err }, "poll_dispatch_failed");
        return { key, started: false };
      }
    }),
  );

  return {
    started: results.filter((r) => r.started).map((r) => r.key),
    // Only the full pool: it is the one refusal that is not an error, does not
    // resolve within a tick, and that a person waiting on the ticket has to be
    // told about. The racing reasons stay in the log above.
    refusedAtCapacity: results
      .filter((r) => !r.started && r.reason === "at_capacity")
      .map((r) => r.key),
  };
}

function normalizeTicketKeys(ticketKeys: string[]): string[] {
  const expectedPrefix = `${env.JIRA_PROJECT_KEY.trim().toUpperCase()}-`;
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
