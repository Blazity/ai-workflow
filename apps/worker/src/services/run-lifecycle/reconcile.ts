import { getRun } from "workflow/api";
import { defaultSettingsSnapshot, type SettingsSnapshot } from "@shared/contracts";
import {
  decideConnectedAiReviewRun,
  decideAiReviewRun,
  isAiReviewDestination,
  prematureAiReviewCancellationReason,
  withdrawConnectedTicketFromAiForRun,
  withdrawTicketFromAiForRun,
} from "../tickets/index.js";
import {
  cancelRunDetailed,
  cancelSubjectRunDetailed,
  type CancelRunResult,
} from "./cancel-run.js";
import { logger } from "../../infra/logger.js";
import {
  getConnectedResumableClarificationForRun,
  getResumableClarificationForRun,
  type HookClarificationRow,
} from "../../db/repositories/clarification-hooks.js";
import { retireConnectedClarificationForGoneTicket } from "../../db/repositories/clarifications.js";
import { stopSandboxesByIds } from "../../sandbox/stop-ticket-sandboxes.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type IssueTrackerMoveTarget,
} from "../../adapters/issue-tracker/types.js";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
} from "../../adapters/run-registry/types.js";
import type { Db } from "../../db/types.js";
import {
  findConnectedRunOutcomeByRunId,
  findRunOutcomeByRunId,
} from "../../db/repositories/runs.js";
import { confirmWorkflowStepsDrained } from "./workflow-step-drain.js";
import {
  reconcileConnectedStartupWatchdog,
  reconcileStartupWatchdog,
} from "./run-start-lifecycle.js";
import {
  reconcileConnectedStalledRun,
  reconcileStalledRun,
} from "./run-stall-watchdog.js";
import {
  trackerIdentityOf,
  type ConnectedIssueTracker,
} from "../../engine/support/issue-tracker-runtime.js";
import { ticketSubjectKey } from "../../engine/support/subject-key.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const NON_TERMINAL_STATUSES = new Set(["pending", "running"]);
const STORE_TERMINAL_STATUSES = new Set(["success", "failed", "blocked"]);
const STALE_RESERVATION_MS = 5 * 60 * 1000;
const ORPHAN_GRACE_MS = 30 * 1000;

/**
 * A ticket-triggered run can reach a terminal Workflow status without any
 * node ever moving its ticket out of the AI column: a `terminate` node with
 * terminalStatus "done"/"skipped" (e.g. an injection screen's block path)
 * only posts a comment, on purpose - "the block owns the ticket status", not
 * the platform. Left alone, the claim below would simply be released while
 * the ticket stays in AI, and the very next poll's JQL discovery re-dispatches
 * the same ticket forever. This is the platform-level safety net: it does not
 * depend on the workflow author remembering update_ticket_status.
 */
const STUCK_TICKET_EVICTION_REASON =
  "Reconciler moved this ticket to Backlog: its most recent run ended without moving the ticket out of the AI column.";

/**
 * A parked ticket is invisible to the poll's JQL, so one Jira can no longer
 * find used to wait for the 7-day hook TTL. This matches the orphan policy.
 */
const PARKED_TICKET_READ_CONCURRENCY = 5;

function missingTicketCancellationReason(ticketKey: string): string {
  return `Orphaned run cancelled by reconciler: ticket ${ticketKey} could not be found (deleted or no longer visible to the integration)`;
}

type TicketCancellationReason = "orphaned_run" | "inflight_claim";
type TicketCancellationCallback = (
  ticketKey: string,
  reason: TicketCancellationReason,
) => Promise<void> | void;
type SubjectReleasedCallback = (subjectKey: string) => Promise<void> | void;
type ClarificationRetirement = (
  db: Db,
  row: HookClarificationRow,
) => Promise<void>;

interface ReconcilePersistence {
  reconcileStartup(
    input: Omit<Parameters<typeof reconcileStartupWatchdog>[0], "db">,
  ): ReturnType<typeof reconcileStartupWatchdog>;
  reconcileStalled(
    input: Omit<Parameters<typeof reconcileStalledRun>[0], "db">,
  ): ReturnType<typeof reconcileStalledRun>;
  decideAiReview(runId: string): ReturnType<typeof decideAiReviewRun>;
  findRunOutcome(runId: string): ReturnType<typeof findRunOutcomeByRunId>;
  getResumableClarification(
    runId: string,
  ): ReturnType<typeof getResumableClarificationForRun>;
  retireClarification?: (row: HookClarificationRow) => Promise<void>;
  withdrawTicket(
    input: Omit<Parameters<typeof withdrawTicketFromAiForRun>[0], "db">,
  ): Promise<boolean>;
}

function createReconcilePersistence(
  db: Db | undefined,
  retireClarification: ClarificationRetirement | undefined,
): ReconcilePersistence {
  if (db) {
    return {
      reconcileStartup: (input) => reconcileStartupWatchdog({ ...input, db }),
      reconcileStalled: (input) => reconcileStalledRun({ ...input, db }),
      decideAiReview: (runId) => decideAiReviewRun(db, runId),
      findRunOutcome: (runId) => findRunOutcomeByRunId(db, runId),
      getResumableClarification: (runId) =>
        getResumableClarificationForRun(db, runId),
      retireClarification: retireClarification
        ? (row) => retireClarification(db, row)
        : undefined,
      withdrawTicket: (input) => withdrawTicketFromAiForRun({ ...input, db }),
    };
  }
  return {
    reconcileStartup: reconcileConnectedStartupWatchdog,
    reconcileStalled: reconcileConnectedStalledRun,
    decideAiReview: decideConnectedAiReviewRun,
    findRunOutcome: findConnectedRunOutcomeByRunId,
    getResumableClarification: getConnectedResumableClarificationForRun,
    retireClarification: retireConnectedClarificationForGoneTicket,
    withdrawTicket: withdrawConnectedTicketFromAiForRun,
  };
}

/**
 * A claim whose lifecycle follows a ticket's column. Every decision about one
 * (still in AI, left AI, stuck in AI, moved to AI Review) needs the board.
 */
function followsTicketColumnOf(entry: ActiveRunEntry): boolean {
  return (entry.kind === "ticket" || entry.kind === "manual_ticket") && entry.ticketKey !== null;
}

/** What a pass knows about the board, built once from its tracker resolution. */
interface ReconcileBoard {
  readonly aiColumnTickets: ReadonlySet<string>;
  readonly adapter: IssueTrackerAdapter;
  readonly trackerId: string;
  readonly trackerName: string;
  /** Upper-cased, as a ticket's project key is compared. */
  readonly projectKey: string;
  readonly aiReviewTransitionId: string | undefined;
  readonly backlogTarget: IssueTrackerMoveTarget;
  readonly identity: string;
}

/**
 * @param aiColumnTickets The tickets in the AI column this pass, or `null` when
 *   the caller has no snapshot of the board (no tracker connected, its settings
 *   unreadable, or the column read failed). See "no board" below.
 * @param tracker The tracker resolution the caller's column snapshot came
 *   from, the poller's one resolution for its tick. The pass reads its
 *   adapter, its id and its wiring from this one value and never resolves the
 *   tracker again: a second read could answer from a tracker switched or
 *   reconnected in between, and pair one tracker's adapter with another's
 *   board.
 */
export async function reconcileRuns(
  aiColumnTickets: ReadonlySet<string> | null,
  runRegistry: RunRegistryAdapter,
  tracker?: ConnectedIssueTracker,
  onTicketCancelled?: TicketCancellationCallback,
  onSubjectReleased?: SubjectReleasedCallback,
  parkedSubjects?: ReadonlySet<string>,
  db?: Db,
  terminalReconciliationSubjects?: ReadonlySet<string>,
  retireClarification?: ClarificationRetirement,
  settings: SettingsSnapshot = defaultSettingsSnapshot(),
): Promise<{ cancelled: number; cleaned: number }> {
  const persistence = createReconcilePersistence(db, retireClarification);
  let cancelled = 0;
  try {
    const startup = await persistence.reconcileStartup({
      runRegistry,
      onSubjectReleased,
    });
    cancelled += startup.cancelled;
  } catch (error) {
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "startup_watchdog_reconciliation_failed",
    );
  }
  const entries = await runRegistry.listAll();
  let cleaned = 0;
  let retainedWithoutBoard = 0;
  const parkedEntries: ActiveRunEntry[] = [];
  /**
   * The board this pass works against, resolved ONCE before the loop.
   *
   * Each of these is a connection read and the loop runs per active claim, so
   * asking inside it turned one pass into one read per claim on a path already
   * bounded by the invocation ceiling. Neither can change while a pass runs,
   * and a pass that saw one change halfway would be worse than one that did
   * not.
   *
   * NO BOARD IS AN ANSWER, NOT A FAILURE. There is none when the caller has
   * no snapshot of the AI column (`aiColumnTickets === null`: no tracker is
   * connected, its settings could not be read, or reading the column failed)
   * or no tracker to read it through. Then every claim that follows
   * a ticket's column is RETAINED untouched, because each decision about one
   * needs the board: an absent column reads as "every ticket left AI" and
   * would cancel runs that are working, and releasing a finished run without
   * moving its ticket out of AI would have the next tick with a board dispatch
   * it again. Everything that is not about a ticket's column still runs: stale
   * reservations, finished pull request, webhook and schedule runs, the stall
   * watchdog for them, and the drains their released subjects start. The
   * earlier shape threw here, which stopped all of that on every tick of a
   * deployment with no tracker.
   *
   * Never a silent degrade to "no transition id" either: deciding the review
   * destination by name alone misses on every board that localizes its status
   * names, and the miss reads as "the ticket left the AI column" on a run that
   * is in fact finishing.
   */
  const issueTracker = tracker?.adapter;
  const board: ReconcileBoard | null =
    aiColumnTickets !== null && tracker
      ? {
          aiColumnTickets,
          adapter: tracker.adapter,
          trackerId: tracker.id,
          trackerName: tracker.name,
          projectKey: tracker.wiring.projectKey.trim().toUpperCase(),
          aiReviewTransitionId: tracker.wiring.aiReviewTransitionId,
          backlogTarget: (tracker.wiring.backlogTransitionId
            ? { name: settings.COLUMN_BACKLOG, transitionId: tracker.wiring.backlogTransitionId }
            : settings.COLUMN_BACKLOG) as IssueTrackerMoveTarget,
          // What identifies the tracker these answers came from, for anything
          // that caches across passes: an admin repointing the connection makes
          // every status id from the old instance meaningless.
          identity: trackerIdentityOf(tracker.id, tracker.wiring.baseUrl),
        }
      : null;

  for (const listedEntry of entries) {
    let entry = listedEntry;
    // A reservation is not about a column: one that never bound is released
    // after its grace period with or without a board, and the ticket stays
    // wherever it is for the next tick that has one.
    if (!board && entry.state !== "reserved" && followsTicketColumnOf(entry)) {
      retainedWithoutBoard++;
      continue;
    }
    // Cancellation failures deliberately retain a dispatch-blocking closing
    // claim. Retry that durable intent before any parked/terminal/orphan logic;
    // a clarification tombstone may have made a previously parked subject
    // closing, and it must not be skipped by the old protection snapshot.
    if (entry.state === "cancelling") {
      const result = await retryCancellingClaim(
        entry,
        board,
        runRegistry,
        issueTracker,
        onSubjectReleased,
        persistence,
        settings,
      );
      if (result.cancelled) {
        if (result.alreadyTerminal) {
          logger.info(
            { ticketKey: entry.ticketKey ?? "", runId: entry.runId },
            "reconcile_released_already_terminal_run",
          );
        } else {
          await notifyTicketCancelled(
            entry.ticketKey ?? "",
            entry.runId ? "orphaned_run" : "inflight_claim",
            entry.ticketKey ? onTicketCancelled : undefined,
          );
        }
        cancelled++;
      } else {
        // Convergence failed again. Until 2026-08-21 this was silent, which is
        // how a claim wedged in "cancelling" (its run's last step never
        // drained) stayed invisible while its ticket was undispatchable.
        logger.warn(
          {
            subjectKey: entry.subjectKey,
            ticketKey: entry.ticketKey ?? "",
            runId: entry.runId,
            tornDown: result.tornDown === true,
          },
          "reconcile_cancelling_claim_unconverged",
        );
      }
      continue;
    }

    if (entry.state === "parking") {
      const recovered = await recoverParkingClaim(entry, runRegistry);
      if (!recovered) continue;
      entry = recovered;
    }

    // A pending clarification suspends the same Workflow while its ticket is
    // parked outside AI. Do not mistake that deliberate wait for an orphan, but
    // do end the wait when the tracker can no longer find that ticket.
    if (parkedSubjects?.has(entry.subjectKey)) {
      // A provider not-found follows the same gone policy as the ordinary
      // orphan verification in verifyTicketLeftAiColumn below, including loss
      // of visibility to the integration. The reads are batched after the loop.
      parkedEntries.push(entry);
      continue;
    }

    // Once answered, that Workflow may keep running while the ticket remains
    // outside AI. Reconcile only terminal cleanup: cleanFinishedRun retains the
    // exact owner until the whole Workflow and every durable step have drained.
    if (
      terminalReconciliationSubjects?.has(entry.subjectKey) &&
      entry.state !== "bound"
    ) {
      if (entry.runId) {
        cleaned += await cleanFinishedRun(
          { ...entry, runId: entry.runId },
          runRegistry,
          onSubjectReleased,
        );
      }
      continue;
    }

    if (entry.state === "reserved") {
      cleaned += await recoverStaleReservation(
        entry,
        runRegistry,
        onSubjectReleased,
      );
      continue;
    }
    if (!entry.runId) continue;
    const boundEntry = { ...entry, runId: entry.runId };

    const followsTicketColumn = followsTicketColumnOf(entry);
    const ticketStillInAiColumn =
      followsTicketColumn && board !== null && board.aiColumnTickets.has(entry.ticketKey as string);

    // A bound run whose engine died (its newest step has been "running" longer
    // than any invocation can live) looks exactly like a healthy in-progress
    // run to every branch below. Settle it here, before the column logic, so it
    // cannot sit in RUNNING with a live claim until someone notices.
    if (entry.state === "bound") {
      const stalled = await persistence.reconcileStalled({
        entry: boundEntry,
        runRegistry,
        ...(board ? { trackerId: board.trackerId } : {}),
        issueTracker,
        // The snapshot only drives ordinary terminal/stuck cleanup. The stall
        // watchdog must receive the configured safe target for every ticket
        // claim so its live Jira read can distinguish AI from a destination
        // selected after this poll snapshot was taken.
        moveTarget: followsTicketColumn && board ? board.backlogTarget : undefined,
        aiColumn: settings.COLUMN_AI,
        onSubjectReleased,
      }).catch((error) => {
        logger.warn(
          {
            subjectKey: entry.subjectKey,
            runId: entry.runId,
            error: error instanceof Error ? error.message : String(error),
          },
          "stall_watchdog_reconciliation_failed",
        );
        return false;
      });
      if (stalled) {
        cancelled++;
        continue;
      }
    }

    // Answered clarifications normally run outside AI and use terminal-only
    // cleanup, but a bound Workflow can still be stalled. Let the watchdog
    // inspect it before releasing the exact owner; true parked claims were
    // skipped above and never enter this path.
    if (terminalReconciliationSubjects?.has(entry.subjectKey)) {
      cleaned += await cleanFinishedRun(
        boundEntry,
        runRegistry,
        onSubjectReleased,
      );
      continue;
    }

    if (!followsTicketColumn) {
      cleaned += await cleanFinishedRun(
        boundEntry,
        runRegistry,
        onSubjectReleased,
      );
      continue;
    }

    if (ticketStillInAiColumn) {
      cleaned += entry.kind === "manual_ticket"
        ? await cleanFinishedManualTicket(
            boundEntry,
            runRegistry,
            board,
            onSubjectReleased,
            persistence,
            settings,
          )
        : await cleanStuckTicketRun(
            boundEntry,
            entry.ticketKey as string,
            runRegistry,
            board,
            onSubjectReleased,
            settings,
          );
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
    const departure = await verifyTicketLeftAiColumn(
      ticketKey,
      issueTracker,
      settings.COLUMN_AI,
      board?.projectKey,
    );
    if (!departure.left) {
      // The Jira poll is capped, so a manual claim can be absent from its
      // snapshot even though the authoritative read still finds AI. Reuse the
      // owner-fenced terminal cleanup; an uncertain read retains the claim.
      if (entry.kind === "manual_ticket" && departure.trackerStatus !== null) {
        cleaned += await cleanFinishedManualTicket(
          boundEntry,
          runRegistry,
          board,
          onSubjectReleased,
          persistence,
          settings,
        );
      }
      continue;
    }
    const reviewDestination =
      departure.trackerStatus !== null &&
      board !== null &&
      (await isAiReviewDestination({
        issueTracker: issueTracker!,
        ticketKey,
        statusName: departure.trackerStatus,
        statusId: departure.trackerStatusId,
        aiReviewColumn: settings.COLUMN_AI_REVIEW,
        trackerIdentity: board.identity,
        ...(board.aiReviewTransitionId
          ? { aiReviewTransitionId: board.aiReviewTransitionId }
          : {}),
      }));
    if (reviewDestination) {
      const finalization = await decideAiReviewFinalization(
        ticketKey,
        entry.runId,
        persistence,
      );
      if (finalization.retain) continue;
      if (finalization.storeTerminalStatus) {
        cleaned += await cleanStoreTerminalRun(
          boundEntry,
          finalization.storeTerminalStatus,
          runRegistry,
          onSubjectReleased,
        );
        continue;
      }
    }

    const cancellationResult = await cancelRunDetailed({
      subjectKey: entry.subjectKey,
      ticketKey,
      target: entry.runId,
      runRegistry,
      ...(issueTracker ? { issueTracker } : {}),
      ...(onSubjectReleased ? { onReleased: onSubjectReleased } : {}),
      reason:
        reviewDestination && board
          ? prematureAiReviewCancellationReason(board.trackerName)
          : "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
      clarificationNotice: { aiColumnName: settings.COLUMN_AI },
    });
    if (
      await finalizeTicketCancellation({
        ticketKey,
        runId: entry.runId,
        result: cancellationResult,
        onTicketCancelled,
        source: "orphan",
      })
    ) cancelled++;
  }

  const parkedDisposals = await mapInSequentialChunks(
    parkedEntries,
    PARKED_TICKET_READ_CONCURRENCY,
    (entry) =>
      disposeParkedSubjectWithMissingTicket(
        entry,
        runRegistry,
        issueTracker,
        onTicketCancelled,
        onSubjectReleased,
        persistence,
      ),
  );
  for (const disposed of parkedDisposals) {
    if (disposed) cancelled++;
  }

  if (retainedWithoutBoard > 0) {
    logger.info({ retained: retainedWithoutBoard }, "reconcile_ticket_claims_retained");
  }

  // A failed mark is what stops a ticket still in AI from being dispatched
  // again, and "still in AI" is a question for the board: without one, every
  // mark would read as a ticket that left and be cleared.
  const failedTickets = board ? await runRegistry.listAllFailed() : [];
  for (const { ticketKey, meta } of failedTickets) {
    if (board?.aiColumnTickets.has(ticketKey)) continue;
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

/**
 * End a clarification park whose ticket cannot be found. The tracker maps
 * deletion and loss of integration visibility to the same not-found outcome,
 * matching the ordinary orphan policy. Other read failures retain the run.
 *
 * Reports whether the run was cancelled, so the caller counts it like an
 * orphan. The shared finalizer sends the same cancellation notification and
 * skips it when Workflow reports that the run was already terminal.
 */
function disposeParkedSubjectWithMissingTicket(
  entry: ActiveRunEntry,
  runRegistry: RunRegistryAdapter,
  issueTracker: IssueTrackerAdapter | undefined,
  onTicketCancelled: TicketCancellationCallback | undefined,
  onSubjectReleased: SubjectReleasedCallback | undefined,
  persistence: ReconcilePersistence,
): Promise<boolean> {
  return disposeParkedSubjectWithMissingTicketCore(
    entry,
    runRegistry,
    issueTracker,
    onTicketCancelled,
    onSubjectReleased,
    persistence,
  ).catch(
    (error: unknown) => {
      logger.warn(
        {
          subjectKey: entry.subjectKey,
          runId: entry.runId,
          error: error instanceof Error ? error.message : String(error),
        },
        "reconcile_parked_disposal_failed",
      );
      return false;
    },
  );
}

async function disposeParkedSubjectWithMissingTicketCore(
  entry: ActiveRunEntry,
  runRegistry: RunRegistryAdapter,
  issueTracker: IssueTrackerAdapter | undefined,
  onTicketCancelled: TicketCancellationCallback | undefined,
  onSubjectReleased: SubjectReleasedCallback | undefined,
  persistence: ReconcilePersistence,
): Promise<boolean> {
  const { runId, ticketKey } = entry;
  if (!issueTracker || !runId || !ticketKey) return false;

  // A park without a resumable clarification owns another lifecycle.
  const row = await persistence.getResumableClarification(runId).catch(() => null);
  if (!row) return false;

  try {
    await issueTracker.fetchTicket(ticketKey);
    return false;
  } catch (error) {
    if (!(error instanceof IssueTrackerNotFoundError)) {
      logger.warn(
        {
          ticketKey,
          runId,
          error: error instanceof Error ? error.message : String(error),
        },
        "reconcile_parked_ticket_check_failed",
      );
      return false;
    }
  }

  if (!persistence.retireClarification) {
    throw new Error("Clarification retirement dependency is unavailable");
  }
  await persistence.retireClarification(row);
  // No clarificationNotice on purpose: this path exists because the ticket is
  // GONE from the tracker, so there is no channel left to close the question on
  // and no settings snapshot down here to name a column with.
  const cancellation = await cancelRunDetailed({
    subjectKey: entry.subjectKey,
    ticketKey,
    target: runId,
    runRegistry,
    ...(issueTracker ? { issueTracker } : {}),
    ...(onSubjectReleased ? { onReleased: onSubjectReleased } : {}),
    reason: missingTicketCancellationReason(ticketKey),
  });
  return finalizeTicketCancellation({
    ticketKey,
    runId,
    result: cancellation,
    onTicketCancelled,
    source: "parked_not_found",
  });
}

async function mapInSequentialChunks<T, R>(
  values: readonly T[],
  chunkSize: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const head = await Promise.all(
    values.slice(0, chunkSize).map((value) => map(value)),
  );
  const tail = await mapInSequentialChunks(values.slice(chunkSize), chunkSize, map);
  return [...head, ...tail];
}

async function finalizeTicketCancellation(input: {
  ticketKey: string;
  runId: string;
  result: CancelRunResult;
  onTicketCancelled?: TicketCancellationCallback;
  source: "orphan" | "parked_not_found";
}): Promise<boolean> {
  const { ticketKey, runId, result, onTicketCancelled, source } = input;
  if (!result.cancelled) {
    logger.warn(
      { ticketKey, runId },
      source === "orphan"
        ? "reconcile_orphan_cancel_unconfirmed"
        : "reconcile_missing_ticket_cancel_unconfirmed",
    );
    return false;
  }
  if (result.alreadyTerminal) {
    logger.info({ ticketKey, runId }, "reconcile_released_already_terminal_run");
    return true;
  }
  logger.info(
    { ticketKey, runId },
    source === "orphan"
      ? "reconcile_cancelled_orphaned_run"
      : "reconcile_cancelled_run_for_missing_ticket",
  );
  await notifyTicketCancelled(ticketKey, "orphaned_run", onTicketCancelled);
  return true;
}

async function recoverParkingClaim(
  entry: ActiveRunEntry,
  runRegistry: RunRegistryAdapter,
): Promise<ActiveRunEntry | null> {
  if (!entry.runId) return null;
  try {
    const began = await runRegistry.beginParking(
      entry.subjectKey,
      entry.ownerToken,
      entry.runId,
    );
    if (!began) {
      const current = await runRegistry.get(entry.subjectKey);
      return isExactParkedClaim(current, entry) ? current : null;
    }
    await stopOwnedSandboxes(entry, runRegistry);
    const finished = await runRegistry.finishParking(
      entry.subjectKey,
      entry.ownerToken,
      entry.runId,
    );
    if (!finished) {
      const current = await runRegistry.get(entry.subjectKey);
      return isExactParkedClaim(current, entry) ? current : null;
    }
    return { ...entry, state: "parked", updatedAt: Date.now() };
  } catch (error) {
    logger.warn(
      {
        subjectKey: entry.subjectKey,
        runId: entry.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "reconcile_clarification_parking_unconfirmed",
    );
    return null;
  }
}

function isExactParkedClaim(
  current: ActiveRunEntry | null,
  expected: ActiveRunEntry,
): current is ActiveRunEntry {
  return (
    current?.subjectKey === expected.subjectKey &&
    current.ownerToken === expected.ownerToken &&
    current.runId === expected.runId &&
    current.state === "parked"
  );
}

async function retryCancellingClaim(
  entry: ActiveRunEntry,
  /** The board this pass built from its one tracker resolution, or null with
   *  none. Without one only claims that do not follow a ticket's column reach
   *  here. */
  board: Pick<ReconcileBoard, "trackerId" | "projectKey" | "backlogTarget"> | null,
  runRegistry: RunRegistryAdapter,
  issueTracker: IssueTrackerAdapter | undefined,
  onSubjectReleased: SubjectReleasedCallback | undefined,
  persistence: ReconcilePersistence,
  settings: SettingsSnapshot = defaultSettingsSnapshot(),
): Promise<CancelRunResult> {
  const target = { ownerToken: entry.ownerToken, runId: entry.runId };
  const reason = entry.runId
    ? "Orphaned run cancelled by reconciler: ticket no longer in the AI column"
    : "In-flight claim cancelled by reconciler: ticket left the AI column before a run was bound";
  // Cancel the subject this claim actually holds. Deriving one from the ticket
  // key was the same string while every run was ticket-keyed; a pull request run
  // carries a ticket key but claims a pull request subject, and cancelling the
  // ticket subject would cancel nothing and leave the claim closing forever.
  if (
    board === null ||
    !entry.ticketKey ||
    entry.subjectKey !== ticketSubjectKey(board.trackerId, entry.ticketKey)
  ) {
    return cancelSubjectRunDetailed(
      entry.subjectKey,
      target,
      runRegistry,
      onSubjectReleased,
      reason,
    );
  }

  const inAiColumn = await readLiveTicketInAiColumn(
    entry.ticketKey,
    issueTracker,
    settings.COLUMN_AI,
    board.projectKey,
  );
  if (inAiColumn === null) {
    logger.warn(
      { ticketKey: entry.ticketKey, runId: entry.runId },
      "reconcile_closing_ticket_state_unconfirmed",
    );
    return { cancelled: false, released: false };
  }
  const ticketKey = entry.ticketKey;
  const backlogTarget = board.backlogTarget;
  const finalFence = async (owner: {
    subjectKey: string;
    ownerToken: string;
    runId: string | null;
  }) => {
    await persistence.withdrawTicket({
      issueTracker: issueTracker!,
      ticketKey,
      aiColumn: settings.COLUMN_AI,
      // The first read is only a snapshot. Keep Backlog available to the final
      // owner fence so a ticket that moved Review -> AI before release is
      // withdrawn instead of becoming dispatchable while this run still owns it.
      target: backlogTarget,
      owner,
      requiredOwnerState: "cancelling",
    });
  };
  return cancelRunDetailed({
    subjectKey: entry.subjectKey,
    ticketKey: entry.ticketKey,
    target,
    runRegistry,
    ...(issueTracker ? { issueTracker } : {}),
    ...(inAiColumn ? { targetColumn: backlogTarget } : {}),
    ...(onSubjectReleased ? { onReleased: onSubjectReleased } : {}),
    reason,
    beforeRelease: finalFence,
    clarificationNotice: { aiColumnName: settings.COLUMN_AI },
  });
}

async function readLiveTicketInAiColumn(
  ticketKey: string,
  issueTracker: IssueTrackerAdapter | undefined,
  aiColumn: string,
  /** The board's project key, upper-cased, from the pass's one resolution. */
  projectKey: string,
): Promise<boolean | null> {
  if (!issueTracker) return null;
  try {
    const ticket = await issueTracker.fetchTicket(ticketKey);
    return (
      ticket.trackerStatus.trim().toLowerCase() === aiColumn.trim().toLowerCase() &&
      resolveTicketProjectKey(ticket) === projectKey
    );
  } catch (error) {
    if (error instanceof IssueTrackerNotFoundError || getErrorCode(error) === "NOT_FOUND") {
      return false;
    }
    logger.warn(
      { ticketKey, error: (error as Error).message },
      "reconcile_closing_ticket_lookup_failed",
    );
    return null;
  }
}

async function recoverStaleReservation(
  entry: ActiveRunEntry,
  runRegistry: RunRegistryAdapter,
  onSubjectReleased?: SubjectReleasedCallback,
): Promise<number> {
  if (runRegistry.releaseExpiredReservation) {
    const released = await runRegistry
      .releaseExpiredReservation(entry.subjectKey, entry.ownerToken)
      .catch(() => false);
    if (!released) return 0;
    // A reservation cannot register a sandbox until its candidate binds, so
    // the atomic expiry delete has no external child to drain.
    await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
    logger.warn(
      { subjectKey: entry.subjectKey, ownerToken: entry.ownerToken },
      "reconcile_cleaned_stale_reservation",
    );
    return 1;
  }

  if (Date.now() - entry.updatedAt <= STALE_RESERVATION_MS) return 0;

  try {
    await stopOwnedSandboxes(entry, runRegistry);
  } catch (error) {
    logger.warn(
      { subjectKey: entry.subjectKey, error: (error as Error).message },
      "reconcile_stale_reservation_cleanup_unconfirmed",
    );
    return 0;
  }
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
    if (!TERMINAL_STATUSES.has(status)) return 0;
    if (!(await confirmWorkflowStepsDrained(entry.subjectKey, entry.runId))) return 0;
    const released = await cleanupAndRelease(entry, runRegistry);
    if (!released) return 0;
    await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
    logger.info(
      { subjectKey: entry.subjectKey, runId: entry.runId, status },
      "reconcile_cleaned_finished_run",
    );
    return 1;
  } catch (error) {
    // Reachability is not terminal proof. Retain the exact owner until Workflow
    // reports a terminal status (or a separately verified cancellation does).
    logger.warn(
      {
        subjectKey: entry.subjectKey,
        runId: entry.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "reconcile_run_status_unreachable_owner_retained",
    );
    return 0;
  }
}

async function cleanFinishedManualTicket(
  entry: ActiveRunEntry & { runId: string },
  runRegistry: RunRegistryAdapter,
  board: Pick<ReconcileBoard, "adapter" | "backlogTarget"> | null,
  onSubjectReleased: SubjectReleasedCallback | undefined,
  persistence: ReconcilePersistence,
  settings: SettingsSnapshot = defaultSettingsSnapshot(),
): Promise<number> {
  try {
    const status = await getRun(entry.runId).status;
    if (!TERMINAL_STATUSES.has(status)) return 0;
    if (!(await confirmWorkflowStepsDrained(entry.subjectKey, entry.runId))) return 0;
    if (!entry.ticketKey || !board) return 0;

    await persistence.withdrawTicket({
      issueTracker: board.adapter,
      ticketKey: entry.ticketKey,
      aiColumn: settings.COLUMN_AI,
      target: board.backlogTarget,
      owner: entry,
      requiredOwnerState: "bound",
    });

    const released = await cleanupAndRelease(entry, runRegistry);
    if (!released) return 0;
    await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
    logger.info(
      { subjectKey: entry.subjectKey, runId: entry.runId, status },
      "reconcile_cleaned_finished_manual_ticket",
    );
    return 1;
  } catch (error) {
    logger.warn(
      {
        subjectKey: entry.subjectKey,
        runId: entry.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "reconcile_manual_ticket_withdrawal_unconfirmed",
    );
    return 0;
  }
}

/**
 * A ticket-triggered run whose ticket is STILL in the AI column, exactly like
 * every genuinely in-progress run - so this only acts once the world confirms
 * the run itself is terminal. At that point the graph is done and nobody
 * moved the ticket, so the platform evicts it to Backlog instead of quietly
 * releasing the claim: releasing without evicting is what let the next poll's
 * JQL discovery see the same ticket and dispatch a second run.
 *
 * Reuses cancelRunDetailed - the exact machinery the "ticket already left AI"
 * branch below uses - which already tolerates a run that is already terminal
 * (workflowRun.cancel() throws, the status re-read confirms it, and the move +
 * release still complete). No "canceled" notification is fired for this path:
 * the run may well have succeeded (e.g. an injection screen's "done" block),
 * so telling an operator it was canceled would be a lie.
 */
async function cleanStuckTicketRun(
  entry: ActiveRunEntry & { runId: string },
  ticketKey: string,
  runRegistry: RunRegistryAdapter,
  board: Pick<ReconcileBoard, "adapter" | "backlogTarget"> | null,
  onSubjectReleased?: SubjectReleasedCallback,
  settings: SettingsSnapshot = defaultSettingsSnapshot(),
): Promise<number> {
  try {
    const status = await getRun(entry.runId).status;
    if (!TERMINAL_STATUSES.has(status)) return 0;
  } catch (error) {
    logger.warn(
      {
        subjectKey: entry.subjectKey,
        runId: entry.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      "reconcile_run_status_unreachable_owner_retained",
    );
    return 0;
  }

  if (!board) return 0;

  const result = await cancelRunDetailed({
    subjectKey: entry.subjectKey,
    ticketKey,
    target: entry.runId,
    runRegistry,
    issueTracker: board.adapter,
    targetColumn: board.backlogTarget,
    ...(onSubjectReleased ? { onReleased: onSubjectReleased } : {}),
    reason: STUCK_TICKET_EVICTION_REASON,
    clarificationNotice: { aiColumnName: settings.COLUMN_AI },
  });
  if (!result.cancelled) {
    logger.warn(
      { ticketKey, runId: entry.runId },
      "reconcile_stuck_ticket_evict_unconfirmed",
    );
    return 0;
  }
  logger.info(
    { ticketKey, runId: entry.runId },
    "reconcile_evicted_stuck_ticket_from_ai_column",
  );
  return 1;
}

async function cleanupAndRelease(
  entry: ActiveRunEntry & { runId: string },
  runRegistry: RunRegistryAdapter,
): Promise<boolean> {
  try {
    await stopOwnedSandboxes(entry, runRegistry);
  } catch (error) {
    logger.warn(
      { subjectKey: entry.subjectKey, runId: entry.runId, error: (error as Error).message },
      "reconcile_terminal_sandbox_cleanup_unconfirmed",
    );
    return false;
  }
  return runRegistry
    .release(entry.subjectKey, entry.ownerToken, entry.runId)
    .catch(() => false);
}

async function stopOwnedSandboxes(
  entry: Pick<ActiveRunEntry, "subjectKey" | "ownerToken">,
  runRegistry: RunRegistryAdapter,
): Promise<void> {
  const sandboxIds = await runRegistry
    .listSandboxes(entry.subjectKey, entry.ownerToken);
  await stopSandboxesByIds(sandboxIds);
}

async function verifyTicketLeftAiColumn(
  ticketKey: string,
  issueTracker: IssueTrackerAdapter | undefined,
  aiColumn: string,
  /** The board's project key, upper-cased, from the pass's one resolution;
   *  absent exactly when the tracker is. */
  expectedProjectKey: string | undefined,
): Promise<{
  left: boolean;
  trackerStatus: string | null;
  trackerStatusId: string | null;
}> {
  if (!issueTracker || expectedProjectKey === undefined) {
    return { left: true, trackerStatus: null, trackerStatusId: null };
  }

  try {
    const ticket = await issueTracker.fetchTicket(ticketKey);
    const ticketStatus = ticket.trackerStatus.trim().toLowerCase();
    const expectedStatus = aiColumn.trim().toLowerCase();
    const ticketProjectKey = resolveTicketProjectKey(ticket);
    const trackerStatusId = ticket.trackerStatusId ?? null;
    if (ticketStatus === expectedStatus && ticketProjectKey === expectedProjectKey) {
      logger.info(
        { ticketKey, status: ticket.trackerStatus, projectKey: ticketProjectKey },
        "reconcile_kept_run_missing_from_poll_snapshot",
      );
      return { left: false, trackerStatus: ticket.trackerStatus, trackerStatusId };
    }
    return { left: true, trackerStatus: ticket.trackerStatus, trackerStatusId };
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError || getErrorCode(err) === "NOT_FOUND") {
      return { left: true, trackerStatus: null, trackerStatusId: null };
    }
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "reconcile_orphan_verification_failed",
    );
    return { left: false, trackerStatus: null, trackerStatusId: null };
  }
}

/**
 * A ticket sitting in the AI Review column is retained while its bound run is
 * still executing only when the exact run has a recorded outcome or durable
 * PR/publication evidence. That preserves the genuine post-PR finalization
 * race without treating an eager human move with no evidence as success.
 * Once the Workflow world is terminal, release it through this same orphan
 * path (cancelRun's already-terminal branch) exactly as for normal completion.
 * If Workflow status is unreachable or unreadable, an old terminal
 * workflow_runs row is sufficient proof to drain and release the claim
 * directly; a fresh or non-terminal row remains fail-closed. A no-evidence
 * decision still cancels without probing Workflow, except that an old blocked
 * row is already terminal and must not be cancelled again.
 */
async function decideAiReviewFinalization(
  ticketKey: string,
  runId: string,
  persistence: ReconcilePersistence,
): Promise<{ retain: boolean; storeTerminalStatus?: string }> {
  const decision = await persistence.decideAiReview(runId);
  if (decision === "lookup_failed") {
    logger.warn(
      { ticketKey, runId },
      "reconcile_ai_review_run_evidence_lookup_failed",
    );
  }
  if (decision === "cancel") {
    const outcome = await readRunOutcomeFromStore(persistence, runId);
    return outcome?.status === "blocked"
      ? { retain: false, storeTerminalStatus: outcome.status }
      : { retain: false };
  }
  try {
    const status = await getRun(runId).status;
    if (TERMINAL_STATUSES.has(status)) return { retain: false };
    if (NON_TERMINAL_STATUSES.has(status)) {
      logger.info(
        { ticketKey, runId },
        "reconcile_retained_finalizing_run_in_ai_review",
      );
      return { retain: true };
    }
  } catch {
    // Fall back to the durable store below.
  }
  const outcome = await readRunOutcomeFromStore(persistence, runId);
  if (outcome) {
    return { retain: false, storeTerminalStatus: outcome.status };
  }
  logger.info(
    { ticketKey, runId },
    "reconcile_retained_finalizing_run_in_ai_review",
  );
  return { retain: true };
}

async function readRunOutcomeFromStore(
  persistence: ReconcilePersistence,
  runId: string,
): Promise<{ status: string } | null> {
  try {
    const outcome = await persistence.findRunOutcome(runId);
    const completedAtMs = outcome?.completedAt?.getTime();
    if (
      !outcome ||
      !outcome.status ||
      !STORE_TERMINAL_STATUSES.has(outcome.status) ||
      completedAtMs === undefined ||
      !Number.isFinite(completedAtMs) ||
      Date.now() - completedAtMs <= STALE_RESERVATION_MS
    ) {
      return null;
    }
    return { status: outcome.status };
  } catch {
    return null;
  }
}

async function cleanStoreTerminalRun(
  entry: ActiveRunEntry & { runId: string },
  status: string,
  runRegistry: RunRegistryAdapter,
  onSubjectReleased?: SubjectReleasedCallback,
): Promise<number> {
  if (!(await confirmWorkflowStepsDrained(entry.subjectKey, entry.runId))) return 0;
  const released = await cleanupAndRelease(entry, runRegistry);
  if (!released) return 0;
  await notifySubjectReleased(entry.subjectKey, onSubjectReleased);
  logger.info(
    { subjectKey: entry.subjectKey, runId: entry.runId, status },
    "reconcile_released_store_terminal_run",
  );
  return 1;
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
