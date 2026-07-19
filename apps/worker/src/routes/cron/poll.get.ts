import { defineEventHandler, getHeader, createError } from "h3";
import { getWorld } from "workflow/runtime";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { reconcileRuns } from "../../lib/reconcile.js";
import { logger } from "../../lib/logger.js";
import { GateStore } from "../../post-pr-gate/gate-store.js";
import { getDb } from "../../db/client.js";
import { collectSnapshots } from "../../lib/telemetry/collect-snapshots.js";
import { upsertRunSnapshots } from "../../lib/telemetry/run-telemetry.js";
import type { RunsLister } from "../../lib/overview/collect-runs.js";
import {
  drainOldestPendingTrigger,
  recoverAcceptedTriggerDelivery,
} from "../../lib/dispatch-trigger.js";
import {
  listPendingSubjectKeys,
  listRecoverableAcceptedTriggerDeliveries,
} from "../../lib/trigger-delivery-store.js";
import {
  recoverAcceptedTriggerDeliveries,
  recoverOrphanedPendingTriggers,
} from "../../lib/pending-trigger-recovery.js";
import {
  classifyProtectedClarificationSubjects,
  reconcileClarificationCheckpoints,
} from "../../clarifications/store.js";
import { ticketSubjectKey } from "../../lib/subject-key.js";
import {
  recoverClarificationProviderParking,
  recoverInterruptedClarificationParking,
  recoverUndispatchedClarificationSuccessors,
  startQueuedClarificationSnapshotCleanups,
} from "../../clarifications/reconciliation.js";
import { dispatchPlanApproved } from "../../approvals/dispatch.js";
import {
  getApproval,
  listDispatchBlockingApprovals,
  type ApprovalRow,
} from "../../approvals/store.js";

const ACCEPTED_TRIGGER_RECOVERY_GRACE_MS = 30_000;

export default defineEventHandler(async (event) => {
  verifyCronAuth(getHeader(event, "authorization"));

  const adapters = createAdapters();
  const db = getDb();

  // Retire expired/orphaned checkpoints before retrying answer crash
  // boundaries. A failed DB read aborts this poll: running generic cleanup
  // without knowing which subjects are durably parked could release live work.
  await reconcileClarificationCheckpoints(db);
  const clarificationParkingRecovered =
    await recoverInterruptedClarificationParking({
      db,
      runRegistry: adapters.runRegistry,
    });
  const clarificationProviderParkingRecovered =
    await recoverClarificationProviderParking({
      db,
      runRegistry: adapters.runRegistry,
      issueTracker: adapters.issueTracker,
      messaging: adapters.messaging,
      dashboardOrigin: env.DASHBOARD_ORIGIN,
      target: env.JIRA_BACKLOG_TRANSITION_ID
        ? {
            name: env.COLUMN_BACKLOG,
            transitionId: env.JIRA_BACKLOG_TRANSITION_ID,
          }
        : env.COLUMN_BACKLOG,
    });
  const clarificationRecovered =
    await recoverUndispatchedClarificationSuccessors({
      db,
      runRegistry: adapters.runRegistry,
      issueTracker: adapters.issueTracker,
      maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
    });
  const clarificationProtection =
    await classifyProtectedClarificationSubjects(db);
  const protectedClarificationSubjects = new Set(clarificationProtection.all);
  const terminalClarificationSubjects = new Set(
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

  // Durable clarification recovery owns its subject before generic AI-column
  // discovery. Even when capacity prevents a missing successor reservation
  // from being recreated on this tick, the answered checkpoint remains
  // protected and cannot be replaced by a fresh ticket workflow.
  const ticketKeys = await discoverAiColumnTickets(adapters);

  const releasedTriggerRecovery = { attempted: 0, started: 0, errors: 0 };
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
    retainedClarificationSubjects,
    db,
    terminalClarificationSubjects,
  );

  const approvalRecovery = await recoverApprovedPlanDispatches(
    blockingApprovals,
    db,
    adapters,
  );
  const started = await dispatchDiscoveredTickets(
    ticketKeys,
    adapters,
    protectedDiscoverySubjects,
  );

  const clarificationCleanupStarted =
    await startQueuedClarificationSnapshotCleanups({ db });

  const acceptedTriggerRecovery = await recoverAcceptedTriggerDeliveries({
    listDeliveries: () =>
      listRecoverableAcceptedTriggerDeliveries(
        db,
        new Date(Date.now() - ACCEPTED_TRIGGER_RECOVERY_GRACE_MS),
      ),
    isProtected: (subjectKey) =>
      protectedClarificationSubjects.has(subjectKey),
    getActive: (subjectKey) => adapters.runRegistry.get(subjectKey),
    resume: (delivery) =>
      recoverAcceptedTriggerDelivery(delivery, {
        db,
        runRegistry: adapters.runRegistry,
        maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      }),
    onError: (subjectKey, error) =>
      logger.warn(
        { subjectKey, error: (error as Error).message },
        "poll_accepted_trigger_recovery_failed",
      ),
  });

  const orphanedTriggerRecovery = await recoverOrphanedPendingTriggers({
    listSubjects: () => listPendingSubjectKeys(db),
    isProtected: (subjectKey) =>
      protectedClarificationSubjects.has(subjectKey),
    getActive: (subjectKey) => adapters.runRegistry.get(subjectKey),
    drain: (subjectKey) =>
      drainOldestPendingTrigger(subjectKey, {
        db,
        runRegistry: adapters.runRegistry,
        maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      }),
    onError: (subjectKey, error) =>
      logger.warn(
        { subjectKey, error: (error as Error).message },
        "poll_pending_trigger_recovery_failed",
      ),
  });

  // Housekeeping: physically drop expired gate rows (reads already treat
  // them as absent). Best-effort — a failed purge must not fail the poll.
  await new GateStore(db)
    .purgeExpired()
    .catch((err) => logger.warn({ err: (err as Error).message }, "poll_gate_purge_failed"));

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
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "poll_snapshot_failed");
  }

  return {
    status: "ok",
    discovered: ticketKeys.length,
    started: started.length,
    cancelled,
    cleaned,
    pendingRecovered:
      releasedTriggerRecovery.started +
      acceptedTriggerRecovery.started +
      orphanedTriggerRecovery.started,
    triggerRecovery: {
      released: releasedTriggerRecovery,
      accepted: acceptedTriggerRecovery,
      orphaned: orphanedTriggerRecovery,
    },
    clarificationRecovered,
    clarificationParkingRecovered,
    clarificationProviderParkingRecovered,
    clarificationCleanupStarted,
    approvalRecovery,
  };
});

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
): Promise<string[]> {
  // Dispatch in parallel. dispatchTicket is internally atomic — the
  // post-claim fairness check in src/lib/dispatch.ts caps started
  // workflows at MAX_CONCURRENT_AGENTS even when racers run concurrently,
  // so excess parallel dispatches safely return `at_capacity`.
  const results = await Promise.all(
    ticketKeys.map(async (key) => {
      if (protectedSubjects.has(ticketSubjectKey("jira", key))) {
        return { key, started: false };
      }
      try {
        const result = await dispatchTicket(
          key,
          adapters,
          env.MAX_CONCURRENT_AGENTS,
        );
        return { key, started: result.started };
      } catch (err) {
        logger.warn({ ticketKey: key, error: err }, "poll_dispatch_failed");
        return { key, started: false };
      }
    }),
  );

  return results.filter((r) => r.started).map((r) => r.key);
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
