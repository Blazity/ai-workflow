import type { SettingsSnapshot } from "@shared/contracts";
import { getWorld } from "workflow/runtime";
import { logger } from "../../../infra/logger.js";
import { GateStore } from "../../../post-pr-gate/gate-store.js";
import { deleteConnectedExpiredRunObservations } from "../../../db/repositories/runs/run-observability.js";
import { deleteConnectedExpiredAgentBriefings } from "../../../db/repositories/agent-visibility.js";
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
import type {
  ConnectedIssueTracker,
  IssueTrackerRefusal,
} from "../../../engine/support/issue-tracker-runtime.js";
import { ticketSubjectKey } from "../../../engine/support/subject-key.js";
import type { IssueTrackerAdapter } from "../../../adapters/issue-tracker/types.js";
import { reconcileRuns } from "../../run-lifecycle/index.js";
import {
  createConnectedScheduleDispatchDeps,
  runScheduleTriggerPass,
} from "../../schedule-trigger/index.js";
import {
  maxConcurrentAgents,
  ticketBoardOf,
  type TicketBoardSettings,
} from "../../settings/index.js";
import {
  collectConnectedSnapshots,
} from "../../telemetry/index.js";
import {
  sweepConnectedOrphanedAwaitingRuns,
  sweepConnectedOrphanedRunningRuns,
  upsertConnectedRunSnapshots,
} from "../../../db/repositories/runs/telemetry.js";
import { createAdapters, type Adapters } from "../../../engine/support/adapters.js";
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

/**
 * What the tick reports about its one catalog read.
 *
 * `ok` when a phase asked and got it, `failed` when the read threw, and
 * `not_needed` when no phase on this tick had a dispatch decision to make and
 * the table was never touched.
 *
 * `failed` holds exactly four phases, and they are worth naming because the
 * field is the only place a reader can see it happened: ticket dispatch
 * (`ticket_dispatch`), manual dispatch recovery, the released-trigger drain and
 * pending-trigger recovery. Each starts nothing on this tick; the work stays
 * where it was and the next tick picks it up.
 *
 * Two dispatch paths deliberately do NOT hold, because neither runs inside this
 * pass: a schedule fires from its own route with its own catalog read, and a
 * webhook redelivery is the provider retrying an ingress. Both have a caller to
 * answer to and a retry of their own, which a ticket sitting in a column does
 * not.
 */
export type PollCatalogRead = "ok" | "failed" | "not_needed";

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
 *
 * The phases that ask, and therefore hold: `ticket_dispatch`,
 * `manual_dispatch_recovery`, `released_trigger_drain` and
 * `pending_trigger_recovery`. See `PollCatalogRead` for the two dispatch paths
 * that deliberately do not.
 *
 * Fail-closed and no longer QUIET. Every skipped phase is logged at ERROR with
 * the message and the stack of the read that failed, because the shape of this
 * incident is "dispatch stopped for a tick and the log said nothing an alert
 * could fire on". The event name stays `poll_repository_catalog_skipped`, and
 * the tick result carries `catalogRead` so the run summary shows it without
 * anybody having to grep.
 *
 * Extracted from `runPollPass` so exactly this can be tested: the pass itself
 * reaches half the deployment and the behaviour worth pinning is here.
 */
export function createRepositoryCatalogReader(
  load: () => Promise<RepositoryCatalogSnapshot>,
): {
  read: (phase: string) => Promise<RepositoryCatalogSnapshot | null>;
  outcome: () => PollCatalogRead;
} {
  let failure: unknown = null;
  let asked = false;
  return {
    read: async (phase: string): Promise<RepositoryCatalogSnapshot | null> => {
      asked = true;
      if (failure === null) {
        try {
          return await load();
        } catch (error) {
          failure = error;
          logger.error(
            {
              phase,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            "poll_repository_catalog_load_failed",
          );
        }
      }
      // Every phase that goes without a catalog says so by name, INCLUDING the
      // one whose read failed. Without this the tick reported one failed load
      // and silently skipped however many dispatch phases came after it, which
      // reads in the log as those phases simply having nothing to do.
      logger.error(
        {
          phase,
          error: failure instanceof Error ? failure.message : String(failure),
          stack: failure instanceof Error ? failure.stack : undefined,
        },
        "poll_repository_catalog_skipped",
      );
      return null;
    },
    outcome: (): PollCatalogRead =>
      failure !== null ? "failed" : asked ? "ok" : "not_needed",
  };
}

/**
 * Why the ticket phases (discovery, approval recovery, ticket dispatch, the
 * at-capacity queue) did not run on a tick. The one thing a reader cannot
 * infer from the counts: a quiet tick and a tick with no board both report
 * zero everything, and only one of them is a deployment not watching a board.
 *
 * - `no_issue_tracker_connected`: nothing serves issue tracking here. An answer
 *   about the deployment, not a failure, so it is logged at info: on a
 *   deployment that never connected a tracker it is the shape of every tick.
 * - `issue_tracker_ambiguous`: two trackers serve it and none is selected. A
 *   misconfiguration that silently stops all ticket discovery and dispatch
 *   until an admin picks one, logged with the sentence that says so.
 * - `issue_tracker_unusable`: the one tracker cannot serve (it ships no code,
 *   or cannot say which account it acts as), with its sentence.
 * - `issue_tracker_unreadable`: the integration settings could not be read, so
 *   nobody knows whether a tracker is connected.
 * - `board_read_failed`: a tracker is connected and reading its AI column
 *   failed (a 401, a timeout).
 * - `dispatch_protection_unreadable`: the clarification and approval records
 *   that say which subjects a new run must not replace could not be read.
 * - `ticket_phases_failed`: the phases started and something in them threw.
 *
 * Every reason but the first is logged at error with what threw.
 */
type TicketPhasesSkipReason =
  | "no_issue_tracker_connected"
  | "issue_tracker_ambiguous"
  | "issue_tracker_unusable"
  | "issue_tracker_unreadable"
  | "board_read_failed"
  | "dispatch_protection_unreadable"
  | "ticket_phases_failed";

/**
 * The AI column this tick, read through the tick's ONE tracker resolution (the
 * one `createAdapters` made), or why there is none. Every tracker call and
 * every subject key on the tick comes from `tracker`, so none of them can
 * answer from a different resolution than the board did.
 */
type BoardRead =
  | {
      readonly ok: true;
      readonly tracker: ConnectedIssueTracker;
      readonly settings: TicketBoardSettings;
      readonly ticketKeys: string[];
    }
  | { readonly ok: false; readonly reason: TicketPhasesSkipReason };

/**
 * What a new run on this tick must not replace and the reconciler must treat
 * gently. Database records, not the board, so it is read whether or not a
 * tracker is connected.
 */
interface DispatchProtection {
  /** Every subject a clarification holds. Dispatch leaves these alone. */
  readonly clarificationSubjects: ReadonlySet<string>;
  /** Claims whose run is finished, released quietly rather than through the
   *  orphan cancellation cascade: clarification successors and approval parks. */
  readonly terminalSubjects: ReadonlySet<string>;
  /** Claims a clarification is waiting on, which the reconciler retains. */
  readonly retainedSubjects: ReadonlySet<string>;
  /** Pending decisions and approved plans not yet dispatched. Each owns its
   *  ticket's next path. */
  readonly blockingApprovals: ApprovalRow[];
}

interface TicketPhases {
  ticketsHeld: boolean;
  started: string[];
  approvalRecovery: Awaited<ReturnType<typeof recoverApprovedPlanDispatches>>;
  atCapacityQueue: { queued: number; commented: number };
}

const NO_TICKET_PHASES: TicketPhases = {
  ticketsHeld: false,
  started: [],
  approvalRecovery: { scanned: 0, started: 0, blocked: 0, errors: 0 },
  atCapacityQueue: { queued: 0, commented: 0 },
};

function errorFields(error: unknown): { error: string; stack?: string } {
  return error instanceof Error
    ? { error: error.message, ...(error.stack ? { stack: error.stack } : {}) }
    : { error: String(error) };
}

/**
 * The briefings whose retention has passed, swept beside the replay.
 *
 * Briefings go with the replay that reaches them: each carries the later of
 * its run's replay expiry and thirty days from the send, so a run parked past
 * its retention, one whose observations were never captured, and a batch that
 * failed halfway all expire on a later pass.
 *
 * Its own statement, and its own failure: a sweep that cannot run leaves the
 * rest of the tick alone and says so once. Extracted so both halves of that
 * are testable without running the whole pass.
 */
export async function sweepExpiredBriefings(
  sweep: typeof deleteConnectedExpiredAgentBriefings = deleteConnectedExpiredAgentBriefings,
): Promise<{ briefings: number; texts: number }> {
  try {
    return await sweep({});
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "poll_briefing_retention_failed");
    return { briefings: 0, texts: 0 };
  }
}

export async function runPollPass(
  settings: SettingsSnapshot,
  loadRepositoryCatalog: () => Promise<RepositoryCatalogSnapshot>,
) {
  const adapters = await createAdapters();
  // Best-effort, like every other housekeeping phase in this pass: a database
  // blip here must not cost the phases below it. Expiring a clarification
  // whose window has closed has nothing to do with a tracker, and a deployment
  // with none should still do it.
  const clarificationExpiry = await expireConnectedHookClarifications().catch(
    (err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "poll_clarification_expiry_failed",
      );
      return { expired: 0, retryable: 0, cleanupFailed: 0 };
    },
  );

  // The catalog, once per tick, and only for the phases that dispatch. See
  // `createRepositoryCatalogReader` for which phases ask and what they do
  // without it.
  const catalogReader = createRepositoryCatalogReader(loadRepositoryCatalog);
  const repositoryCatalogOrNull = catalogReader.read;

  /*
   * THE RUN PHASES, split by what each one needs.
   *
   * Only the ticket phases need a board: discovery, approval recovery, ticket
   * dispatch and the at-capacity queue. Manual-dispatch recovery, claim
   * reconciliation and the pull request trigger drains are about runs and
   * claims, and run on every tick. No board is an answer (`BoardRead`), not a
   * throw, so a deployment with no tracker, or with one that is failing,
   * skips the ticket phases, says why, and does everything else. All of it
   * used to sit in one ticket half that threw on its first line without a
   * tracker, so on such a deployment no claim was ever released, no manual
   * dispatch recovered and no queued pull request trigger started.
   *
   * The order is the one the protections need. The protection records are read
   * before the board, so a subject is protected for the whole snapshot. Claims
   * are reconciled before anything dispatches, so a released owner is free for
   * its successor, and approval recovery runs after the reconciler has cleared
   * a reserved owner it retained for the ticket's settlement.
   */
  const protection = await readDispatchProtection().catch((error: unknown) => {
    logger.error(errorFields(error), "poll_dispatch_protection_failed");
    return null;
  });
  const board = await readTicketBoard(adapters, settings);

  const manualDispatchRecovery = await recoverManualDispatchRequests(
    adapters,
    settings,
    repositoryCatalogOrNull,
  );

  const releasedTriggerRecovery = { attempted: 0, started: 0, errors: 0 };
  const releasedTriggerSubjects = new Set<string>();
  let claimReconciliation: "ran" | "skipped" | "failed" = "skipped";
  let cancelled = 0;
  let cleaned = 0;
  // Without the protection records the reconciler cannot tell a claim a
  // clarification is waiting on from an orphan, and would cancel it.
  if (protection) {
    try {
      ({ cancelled, cleaned } = await reconcileClaims({
        adapters,
        settings,
        protection,
        aiColumnTickets: board.ok ? board.ticketKeys : null,
        onSubjectReleased: async (subjectKey) => {
          releasedTriggerSubjects.add(subjectKey);
          if (releasedTriggerRecovery.started > 0) return;
          // The claim release around this callback is housekeeping and has
          // already happened; only the successor it could start needs the
          // catalog.
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
      }));
      claimReconciliation = "ran";
    } catch (error) {
      claimReconciliation = "failed";
      logger.error(errorFields(error), "poll_claim_reconciliation_failed");
    }
  }

  const polledTriggerRecovery = await recoverPendingTriggers(
    adapters,
    releasedTriggerSubjects,
    releasedTriggerRecovery.started === 0,
    settings,
    await repositoryCatalogOrNull("pending_trigger_recovery"),
  );

  let ticketPhasesReason: TicketPhasesSkipReason | null = board.ok ? null : board.reason;
  let ticket = NO_TICKET_PHASES;
  if (board.ok && !protection) {
    ticketPhasesReason = "dispatch_protection_unreadable";
    logTicketPhasesSkipped(ticketPhasesReason, {});
  } else if (board.ok && protection) {
    try {
      ticket = await runTicketPhases({
        board,
        protection,
        adapters,
        settings,
        readCatalog: repositoryCatalogOrNull,
      });
    } catch (error) {
      ticketPhasesReason = "ticket_phases_failed";
      logTicketPhasesSkipped(ticketPhasesReason, errorFields(error));
    }
  }
  const ticketKeys = board.ok ? board.ticketKeys : [];
  const { ticketsHeld, started, approvalRecovery, atCapacityQueue } = ticket;

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
  const briefingRetention = await sweepExpiredBriefings();
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

  // The pass summary, in the LOG and not only on the cron response. The
  // response body is read by whoever invoked the tick; an incident is read in
  // the log, and "dispatch held for a tick" was a fact only the response
  // carried. Info, because a healthy tick says the same line with catalogRead
  // "ok" and that is what makes the failed one findable.
  logger.info(
    {
      catalogRead: catalogReader.outcome(),
      ticketPhases: ticketPhasesReason === null ? "ran" : "skipped",
      ticketPhasesReason,
      claimReconciliation,
      discovered: ticketKeys.length,
      started: started.length,
      ticketsHeld: ticketsHeld ? ticketKeys.length : 0,
      pendingRecovered: releasedTriggerRecovery.started + polledTriggerRecovery.started,
      manualDispatchStarted: manualDispatchRecovery.started,
    },
    "poll_pass_summary",
  );

  return {
    status: "ok",
    // Said out loud in the tick's own result: "failed" means every dispatch
    // phase on this tick skipped itself, which the counts below cannot show
    // because they are indistinguishable from a quiet tick.
    catalogRead: catalogReader.outcome(),
    // Said out loud for the same reason as `catalogRead`: zero discovered and
    // zero started is what a quiet tick reports too, and a deployment whose
    // ticket phases never ran must not read as a quiet one. The reason says
    // whether that is the deployment's configuration or something failing.
    ticketPhases: ticketPhasesReason === null ? ("ran" as const) : ("skipped" as const),
    ticketPhasesReason,
    // "skipped" when the protection records could not be read, "failed" when
    // the reconciler threw. Either way no claim was released on this tick.
    claimReconciliation,
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
    briefingRetention,
    mcpAuditRetention: { deleted: mcpAuditRetention.deleted },
    mcpIdempotencyRetention: { deleted: mcpIdempotencyRetention.deleted },
    prCheckReconciliation,
  };
}

async function evaluateScheduleTriggers(
  adapters: Adapters,
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
  adapters: Adapters,
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
  adapters: Adapters,
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

async function readDispatchProtection(): Promise<DispatchProtection> {
  const clarifications = await classifyConnectedProtectedClarificationSubjects();
  // A persisted approval owns the ticket's next path, pending or approved and
  // not yet dispatched, for the entire poll snapshot.
  const blockingApprovals = await listConnectedDispatchBlockingApprovals();
  // The run that filed a plan ended when it parked the ticket outside the AI
  // column, so its bound claim is terminal bookkeeping, not an orphan.
  // Cancelling it retires the pending approval and strands the ticket with
  // nobody able to approve; terminal cleanup releases the same claim quietly,
  // which is what the approval dispatch needs to reserve.
  const terminalSubjects = new Set(clarifications.terminal);
  for (const subjectKey of await listConnectedApprovalParkedSubjects()) {
    terminalSubjects.add(subjectKey);
  }
  return {
    clarificationSubjects: new Set(clarifications.all),
    terminalSubjects,
    retainedSubjects: new Set(clarifications.retained),
    blockingApprovals,
  };
}

function logTicketPhasesSkipped(
  reason: TicketPhasesSkipReason,
  fields: Record<string, unknown>,
): void {
  if (reason === "no_issue_tracker_connected") {
    logger.info({ reason, ...fields }, "poll_ticket_phases_skipped");
  } else {
    logger.error({ reason, ...fields }, "poll_ticket_phases_skipped");
  }
}

const TRACKER_SKIP_REASONS: Record<IssueTrackerRefusal, TicketPhasesSkipReason> = {
  not_connected: "no_issue_tracker_connected",
  ambiguous: "issue_tracker_ambiguous",
  unusable: "issue_tracker_unusable",
  unreadable: "issue_tracker_unreadable",
};

/**
 * The board and the tickets in its AI column, or why there are none. Never
 * throws: a missing tracker is the deployment's configuration and a failed
 * column read is the tracker's failure, and each is an answer the pass acts on
 * by skipping the ticket phases and nothing else.
 */
async function readTicketBoard(
  adapters: Adapters,
  settings: SettingsSnapshot,
): Promise<BoardRead> {
  const tracker = adapters.issueTrackerResolution;
  if (!tracker.ok) {
    const reason = TRACKER_SKIP_REASONS[tracker.refusal];
    logTicketPhasesSkipped(reason, { detail: tracker.reason });
    return { ok: false, reason };
  }
  try {
    const board = await ticketBoardOf(tracker, settings);
    return {
      ok: true,
      tracker,
      settings: board,
      ticketKeys: await discoverAiColumnTickets(tracker.adapter, board),
    };
  } catch (error) {
    logTicketPhasesSkipped("board_read_failed", errorFields(error));
    return { ok: false, reason: "board_read_failed" };
  }
}

async function recoverManualDispatchRequests(
  adapters: Adapters,
  settings: SettingsSnapshot,
  readCatalog: (phase: string) => Promise<RepositoryCatalogSnapshot | null>,
): Promise<Awaited<ReturnType<typeof recoverManualDispatches>>> {
  const none = { scanned: 0, started: 0, recovering: 0, failed: 0 };
  const catalog = await readCatalog("manual_dispatch_recovery");
  if (!catalog) return none;
  return await recoverManualDispatches({
    adapters,
    maxConcurrentAgents: maxConcurrentAgents(settings),
    repositoryCatalog: catalog,
  }).catch((error: unknown) => {
    logger.error(errorFields(error), "poll_manual_dispatch_recovery_failed");
    return none;
  });
}

/**
 * Every claim, reconciled. With no AI column snapshot (`aiColumnTickets` null)
 * the reconciler retains the claims that follow a ticket's column and settles
 * the rest; see "no board" in `reconcileRuns`.
 */
async function reconcileClaims(input: {
  adapters: Adapters;
  settings: SettingsSnapshot;
  protection: DispatchProtection;
  aiColumnTickets: readonly string[] | null;
  onSubjectReleased: (subjectKey: string) => Promise<void>;
}): Promise<{ cancelled: number; cleaned: number }> {
  const { adapters, settings, protection } = input;
  // A claim a clarification is waiting on, or one a manual dispatch is still
  // recovering, belongs to that owner and is not an orphan. Read after manual
  // recovery ran, so a request it just settled is no longer protected.
  const protectedRunSubjects = new Set(protection.retainedSubjects);
  for (const request of await listConnectedRecoverableManualDispatches()) {
    protectedRunSubjects.add(request.subjectKey);
  }
  // The tick's one resolution, the same value `readTicketBoard` read the
  // column through, so the reconciler's adapter and board come from one tracker.
  const tracker = adapters.issueTrackerResolution;
  return await reconcileRuns(
    input.aiColumnTickets === null ? null : new Set(input.aiColumnTickets),
    adapters.runRegistry,
    tracker.ok ? tracker : undefined,
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
    input.onSubjectReleased,
    protectedRunSubjects,
    undefined,
    protection.terminalSubjects,
    retireClarificationForGoneTicket,
    settings,
  );
}

/**
 * The phases that need a board: approval recovery, ticket dispatch and the
 * at-capacity queue. Every tracker call here goes through the board's own
 * resolution.
 */
async function runTicketPhases(input: {
  board: Extract<BoardRead, { ok: true }>;
  protection: DispatchProtection;
  adapters: Adapters;
  settings: SettingsSnapshot;
  readCatalog: (phase: string) => Promise<RepositoryCatalogSnapshot | null>;
}): Promise<TicketPhases> {
  const { board, protection, adapters, settings } = input;
  const approvalRecovery = await recoverApprovedPlanDispatches(
    protection.blockingApprovals,
    adapters,
    board.tracker.adapter,
    settings,
  );

  // Ticket dispatch consults the same reader the recovery phases do, and for a
  // worse failure than theirs: a run started on a tick whose catalog cannot be
  // read does not fail here, it fails INSIDE the workflow, in
  // `loadRunStartSettingsStep`, and the ticket gets a raw database error in
  // front of whoever moved it. Held instead. Nothing is claimed, the ticket
  // stays in the AI column, and the next tick dispatches it.
  //
  // Asked only when there is something to dispatch, so a quiet tick still
  // reports `not_needed` rather than touching the table to decide nothing.
  const dispatchCatalog =
    board.ticketKeys.length === 0 ? null : await input.readCatalog("ticket_dispatch");
  const ticketsHeld = board.ticketKeys.length > 0 && dispatchCatalog === null;

  // Durable clarification recovery and a persisted approval each own their
  // subject before generic AI-column discovery does: even when capacity keeps
  // a missing successor from being reserved on this tick, the subject is not
  // replaced by a fresh ticket workflow.
  const protectedSubjects = new Set(protection.clarificationSubjects);
  for (const approval of protection.blockingApprovals) {
    protectedSubjects.add(ticketSubjectKey(board.tracker.id, approval.ticketKey));
  }
  const dispatchOutcome: DispatchOutcome = ticketsHeld
    ? { started: [], atCapacity: [] }
    : await dispatchDiscoveredTickets(board, adapters, protectedSubjects, settings);

  // Surface every at-capacity refusal on the ticket: queue each refused ticket
  // and post a comment per at-capacity episode (at-least-once, effectively
  // once; retried on a tracker failure; row dropped when the ticket dispatches
  // or leaves the AI column). Best-effort: a failed queue pass must not fail
  // the poll.
  const atCapacityQueue = await reconcileAtCapacityQueue({
    issueTracker: board.tracker.adapter,
    atCapacityKeys: dispatchOutcome.atCapacity,
    startedKeys: dispatchOutcome.started,
    currentTicketKeys: board.ticketKeys,
  }).catch((err) => {
    logger.warn({ err: (err as Error).message }, "poll_at_capacity_queue_failed");
    return { queued: 0, commented: 0 };
  });
  return { ticketsHeld, started: dispatchOutcome.started, approvalRecovery, atCapacityQueue };
}

async function recoverApprovedPlanDispatches(
  blockingApprovals: ApprovalRow[],
  adapters: Adapters,
  issueTracker: IssueTrackerAdapter,
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
          issueTracker,
          approval,
          actor: {
            id: approval.decidedById ?? "system",
            label: approval.decidedByLabel ?? "system",
          },
          maxConcurrentAgents: maxConcurrentAgents(settings),
          settings,
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
  issueTracker: IssueTrackerAdapter,
  board: TicketBoardSettings,
): Promise<string[]> {
  // Core asks what it wants to know, which is "the tickets in this column",
  // and the provider builds its own query. Until S12 this line composed a JQL
  // string, which put one tracker's query language in the poller and made a
  // tracker that cannot parse JQL impossible to use. The stable order that
  // made the old query safe is part of the port's contract now, with the
  // reason it exists written beside it.
  const ticketKeys = await issueTracker.ticketsInStatus(board.aiColumn);
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
  board: Extract<BoardRead, { ok: true }>,
  adapters: Adapters,
  protectedSubjects: ReadonlySet<string>,
  settings: SettingsSnapshot,
): Promise<DispatchOutcome> {
  const { ticketKeys } = board;
  // Dispatch in parallel. dispatchTicket is internally atomic — the
  // post-claim fairness check in src/services/dispatch/dispatch.ts caps started
  // workflows at MAX_CONCURRENT_AGENTS even when racers run concurrently,
  // so excess parallel dispatches safely return `at_capacity`.
  // The subject from the board's own resolution: the same derivation
  // `ticketSubject` makes, without reading the tracker's connection again.
  const results = await Promise.all(
    ticketKeys.map(async (key) => {
      if (protectedSubjects.has(ticketSubjectKey(board.tracker.id, key))) {
        // A protected subject may hold a suspended clarification run whose
        // answers arrived as human comments. Try to wake it (no nudging on the
        // poll: the cron JQL snapshot is not the human's commit gesture). A
        // resumed run needs no dispatch, so this always returns started:false.
        const resume = await resumeConnectedClarificationFromComments({
          issueTracker: board.tracker.adapter,
          ticketKey: key,
          allowNudge: false,
          aiColumn: settings.COLUMN_AI,
          cancelSettings: settings,
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
          settings,
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
  board: TicketBoardSettings,
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
