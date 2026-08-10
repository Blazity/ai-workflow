import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { approvalRequests, clarificationRequests, workflowRuns } from "../../db/schema.js";
import type {
  BlockRunState,
  HarnessRunManifestRecord,
  ResolvedPromptReference,
  RunPullRequest,
  RunStep,
  WorkflowRunBudgetFailure,
} from "@shared/contracts";

/**
 * Lifecycle/status fields the poll cron snapshots from the Workflow world and
 * the run registry. Authoritative for status & timing; ticket/PR fields are
 * best-effort (a flaky Jira/gate lookup one cycle must not erase a good value
 * from a previous cycle — see the COALESCE set below).
 */
export interface RunSnapshot {
  runId: string;
  subjectKey: string | null;
  workflowId: string;
  workflowName: string;
  status: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  sandboxId: string | null;
  createdAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationSec: number | null;
  /** Gate runs only — agent runs get their PR from recordRunUsage. */
  prRepo: string | null;
  prNumber: number | null;
}

/**
 * Cost/usage fields the agent workflow records on completion. This is the only
 * source for per-run cost — it exists transiently inside the run and is gone
 * once the workflow returns.
 */
export interface RunUsage {
  runId: string;
  subjectKey: string;
  /**
   * The workflow's own identity. Written here too (not just by the cron
   * snapshot) so a run is attributable to its workflow even when the cron never
   * observes it — a fast run that starts and finishes within one poll interval,
   * or a deployment where the scheduled cron doesn't fire. Without it the row
   * has a null workflow_id: it reads as wf_unknown in the runs list and counts
   * under no workflow in the workflows table.
   */
  workflowId: string;
  workflowName: string;
  /**
   * Status the run reached on this exit path: "success" (PR opened, or a
   * clarification that completed cleanly), "failed" (any phase failure,
   * timeout, or thrown error), or "awaiting" (parked on a clarification the run
   * filed, not terminal: the answer endpoint owns the later transition to
   * success). This is the run's OWN authoritative status,
   * written by the workflow on completion — it no longer depends on a later
   * cron snapshot re-observing the run in the Workflow world, which never
   * happens on deployments where the scheduled cron doesn't fire (and which
   * mis-reports a failed-but-returned run as "success" even when it does).
   * "blocked" (external cancellation) stays cron-driven.
   */
  status: "success" | "failed" | "awaiting";
  /** Durable failure reason (execution error / budget stop) recorded with a
   * "failed" status so the dashboard can show why; null on other outcomes. */
  statusReason?: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  model: string | null;
  costUsd: number | null;
  costKnown: boolean;
  tokensInput: number | null;
  tokensCached: number | null;
  tokensOutput: number | null;
  /** Per-phase breakdown ({ [phase]: { costUsd, tokens, durationMs, numTurns } }). */
  phases: unknown;
  /** Full step waterfall captured from the world on completion; null if capture failed. */
  steps: RunStep[] | null;
  /** Structured terminal cause when the run stopped on a configured budget. */
  budgetFailure: WorkflowRunBudgetFailure | null;
  prUrl: string | null;
  prNumber: number | null;
  /** Every PR/MR the run opened. prUrl/prNumber above stay the first of these,
   * so a single-repo run and every existing consumer are unaffected. */
  prs: RunPullRequest[] | null;
  /** Exact non-secret profile/runtime capabilities resolved for this run. */
  harnessManifests?: HarnessRunManifestRecord[];
}

/** `coalesce(excluded.<col>, "workflow_runs"."<col>")` — take the incoming
 * value when present, otherwise keep what's already stored. */
function keepIfNull(column: { name: string }, existing: unknown) {
  return sql`coalesce(excluded.${sql.raw(column.name)}, ${existing})`;
}

/**
 * Wall-clock seconds from the recorded start to now, computed only when a start
 * is actually known (a prior cron snapshot set started_at/created_at). Keeps any
 * duration the cron already computed, and stays null when there's no start to
 * measure from (e.g. a workflow-only row on a deployment the cron never touches)
 * rather than fabricating a zero.
 */
function durationFromStart() {
  return sql`coalesce(
    ${workflowRuns.durationSec},
    case
      when coalesce(${workflowRuns.startedAt}, ${workflowRuns.createdAt}) is not null
      then greatest(0, extract(epoch from (now() - coalesce(${workflowRuns.startedAt}, ${workflowRuns.createdAt})))::int)
      else null
    end
  )`;
}

/**
 * Cron writer. Upserts one row per run, setting only lifecycle columns.
 * status/workflowName come straight from the world (always known); ticket and
 * PR fields use COALESCE so a transient lookup miss doesn't wipe a good value
 * or the workflow's own PR.
 */
export async function upsertRunSnapshots(
  db: Db,
  rows: RunSnapshot[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(workflowRuns)
    .values(rows)
    .onConflictDoUpdate({
      target: workflowRuns.runId,
      set: {
        workflowId: sql`excluded.workflow_id`,
        workflowName: sql`excluded.workflow_name`,
        subjectKey: keepIfNull(workflowRuns.subjectKey, workflowRuns.subjectKey),
        // Never downgrade a terminal status. The agent workflow writes the
        // authoritative success/failed on completion (recordRunUsage); a cron
        // snapshot re-deriving status from the world must not clobber it — the
        // world reports a failed-but-returned run as "completed" → "success",
        // and there's a brief post-completion window where it still reads
        // "running". The workflow also records "awaiting" for a run parked on a
        // clarification, and the world reports that parked run "completed" →
        // "success", so the cron must never flip awaiting to success: the answer
        // endpoint owns that transition. Only advance a row that hasn't reached
        // a frozen state.
        status: sql`case
          when ${workflowRuns.status} in ('success', 'failed', 'blocked', 'awaiting') then ${workflowRuns.status}
          else excluded.status
        end`,
        ticketKey: keepIfNull(workflowRuns.ticketKey, workflowRuns.ticketKey),
        ticketTitle: keepIfNull(workflowRuns.ticketTitle, workflowRuns.ticketTitle),
        ticketUrl: keepIfNull(workflowRuns.ticketUrl, workflowRuns.ticketUrl),
        sandboxId: keepIfNull(workflowRuns.sandboxId, workflowRuns.sandboxId),
        createdAt: keepIfNull(workflowRuns.createdAt, workflowRuns.createdAt),
        startedAt: keepIfNull(workflowRuns.startedAt, workflowRuns.startedAt),
        completedAt: keepIfNull(workflowRuns.completedAt, workflowRuns.completedAt),
        durationSec: keepIfNull(workflowRuns.durationSec, workflowRuns.durationSec),
        prRepo: keepIfNull(workflowRuns.prRepo, workflowRuns.prRepo),
        prNumber: keepIfNull(workflowRuns.prNumber, workflowRuns.prNumber),
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Workflow writer. Upserts the cost/usage (and agent PR) for one run, plus the
 * run's authoritative terminal status/completion. Status is the run's own
 * truth on completion — see RunUsage.status. completedAt/durationSec finalize
 * the lifecycle so a run no longer depends on a post-completion cron snapshot
 * (which, on deployments where the scheduled cron doesn't fire, never lands —
 * leaving the row frozen at the cron's last in-flight "running"). PR uses
 * COALESCE so it never erases a gate PR a cron snapshot may have recorded.
 */
export async function recordRunUsage(db: Db, usage: RunUsage): Promise<void> {
  await db
    .insert(workflowRuns)
    .values({
      runId: usage.runId,
      subjectKey: usage.subjectKey,
      workflowId: usage.workflowId,
      workflowName: usage.workflowName,
      status: usage.status,
      statusReason: usage.statusReason ?? null,
      completedAt: sql`now()`,
      ticketKey: usage.ticketKey,
      ticketTitle: usage.ticketTitle,
      ticketUrl: usage.ticketUrl,
      model: usage.model,
      costUsd: usage.costUsd,
      costKnown: usage.costKnown,
      tokensInput: usage.tokensInput,
      tokensCached: usage.tokensCached,
      tokensOutput: usage.tokensOutput,
      phases: usage.phases,
      steps: usage.steps,
      budgetFailure: usage.budgetFailure,
      prUrl: usage.prUrl,
      prNumber: usage.prNumber,
      prs: usage.prs,
      harnessManifests: usage.harnessManifests,
    })
    .onConflictDoUpdate({
      target: workflowRuns.runId,
      set: {
        // The workflow knows the real outcome; overwrite the cron's in-flight
        // "running". completedAt keeps a precise cron-recorded value if present,
        // else stamps now(); durationSec is filled from a known start.
        status: sql`excluded.status`,
        // Never erase a recorded reason with a later re-record that has none
        // (same COALESCE rule as steps).
        statusReason: keepIfNull(workflowRuns.statusReason, workflowRuns.statusReason),
        workflowId: sql`excluded.workflow_id`,
        workflowName: sql`excluded.workflow_name`,
        subjectKey: sql`excluded.subject_key`,
        completedAt: sql`coalesce(${workflowRuns.completedAt}, now())`,
        durationSec: durationFromStart(),
        ticketKey: keepIfNull(workflowRuns.ticketKey, workflowRuns.ticketKey),
        ticketTitle: sql`excluded.ticket_title`,
        ticketUrl: sql`excluded.ticket_url`,
        model: sql`excluded.model`,
        costUsd: sql`excluded.cost_usd`,
        costKnown: sql`excluded.cost_known`,
        tokensInput: sql`excluded.tokens_input`,
        tokensCached: sql`excluded.tokens_cached`,
        tokensOutput: sql`excluded.tokens_output`,
        phases: sql`excluded.phases`,
        // Workflow-owned and capture is best-effort: never erase a good
        // waterfall with a later null (a re-record whose world capture failed).
        steps: keepIfNull(workflowRuns.steps, workflowRuns.steps),
        budgetFailure: sql`excluded.budget_failure`,
        prUrl: keepIfNull(workflowRuns.prUrl, workflowRuns.prUrl),
        prNumber: keepIfNull(workflowRuns.prNumber, workflowRuns.prNumber),
        prs: keepIfNull(workflowRuns.prs, workflowRuns.prs),
        harnessManifests: keepIfNull(
          workflowRuns.harnessManifests,
          workflowRuns.harnessManifests,
        ),
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Block-status fields the agent workflow streams mid-run, keyed by the
 * definition node id. Identity is written here too (INSERT only) so a run is
 * attributable to its workflow even when no cron snapshot ever observes it.
 */
export interface RunBlockStatusWrite {
  runId: string;
  subjectKey: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  definitionVersion: number | null;
  definitionId: number | null;
  blockStatuses: Record<string, BlockRunState>;
  promptManifest?: ResolvedPromptReference[];
  harnessManifests?: HarnessRunManifestRecord[];
}

export function summarizeBlockStatuses(
  blockStatuses: Record<string, BlockRunState>,
): Record<string, BlockRunState> {
  return Object.fromEntries(
    Object.entries(blockStatuses).map(([nodeId, state]) => {
      const { output: _output, ...summary } = state;
      return [nodeId, summary];
    }),
  );
}

/**
 * Block-status writer. Upserts per-block progress for one run, owning exactly
 * block_statuses, definition_version and definition_id (plus updated_at).
 * Identity and a "running" status land only on INSERT (same rationale as
 * recordRunUsage); on conflict it touches nothing the cron snapshot or
 * recordRunUsage own.
 */
export async function recordBlockStatuses(
  db: Db,
  write: RunBlockStatusWrite,
): Promise<void> {
  const blockStatuses = summarizeBlockStatuses(write.blockStatuses);
  await db
    .insert(workflowRuns)
    .values({
      runId: write.runId,
      subjectKey: write.subjectKey,
      workflowId: "wf_agent",
      workflowName: "Agent",
      status: "running",
      ticketKey: write.ticketKey,
      ticketTitle: write.ticketTitle,
      ticketUrl: write.ticketUrl,
      definitionVersion: write.definitionVersion,
      definitionId: write.definitionId,
      blockStatuses,
      promptManifest: write.promptManifest,
      harnessManifests: write.harnessManifests,
    })
    .onConflictDoUpdate({
      target: workflowRuns.runId,
      set: {
        blockStatuses: sql`excluded.block_statuses`,
        definitionVersion: sql`excluded.definition_version`,
        definitionId: sql`excluded.definition_id`,
        promptManifest: keepIfNull(workflowRuns.promptManifest, workflowRuns.promptManifest),
        harnessManifests: keepIfNull(
          workflowRuns.harnessManifests,
          workflowRuns.harnessManifests,
        ),
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Best-effort writer for a run's durable status reason — who cancelled it or
 * why it failed. The Workflow world has no such field (a cancelled run's error
 * is always undefined), so without this a "blocked" row has no explainable
 * cause. An upsert like the other writers here ("whichever writes first
 * inserts the row"): the reason must survive even when no row exists yet — a
 * run cancelled before the cron's first snapshot — so the INSERT carries only
 * runId + statusReason and the later snapshot/usage writes fill in the rest.
 * Callers wrap this in try/catch — recording the reason must never affect the
 * operation that produced it.
 *
 * Precedence is explicit rather than positional, because the two writers race
 * in both orders: a failing run's own backlog move fires the webhook that
 * cancels the orphan, and the reconciler can equally retire a run just before
 * its failure lands. A "failure" reason is the concrete cause and always wins;
 * a "cancellation" reason is bookkeeping and only fills a still-null field, or
 * the trace screen would never say why the run actually failed.
 *
 * A run already recorded as "success" is excluded from the cancellation branch
 * entirely. Retiring the claim of a run that already opened its PR is routine
 * (the reconciler does it for every completed run whose claim outlived the poll
 * snapshot, and a run's own AI Review move fires the same "left the AI column"
 * webhook), and a successful run legitimately has no reason of its own, so the
 * null it carries is not a gap to fill: writing there states a cancellation for
 * a green run. Only "success" is protected. "awaiting" is a parked run, not a
 * finished one, and cancelling it while it waits is a real cause worth keeping.
 */
export type RunStatusReasonKind = "failure" | "cancellation";

export async function recordRunStatusReason(
  db: Db,
  runId: string,
  reason: string,
  options: { kind: RunStatusReasonKind } = { kind: "cancellation" },
): Promise<void> {
  await db
    .insert(workflowRuns)
    .values({ runId, statusReason: reason })
    .onConflictDoUpdate({
      target: workflowRuns.runId,
      set: {
        statusReason:
          options.kind === "failure"
            ? sql`excluded.status_reason`
            : sql`case
                when ${workflowRuns.status} = 'success' then ${workflowRuns.statusReason}
                else coalesce(${workflowRuns.statusReason}, excluded.status_reason)
              end`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Commits a run's authoritative "failed" status the moment its own
 * failure-handling backlog move is about to fire a Jira webhook. The bot moving
 * a failed ticket out of the AI column triggers the "ticket left the AI column"
 * webhook, which would otherwise race in and cancel this still-finalizing run,
 * flipping its world status to "cancelled" (stored as "blocked"), a genuine
 * failure the errors KPI never counts. Recording "failed" first makes the
 * outcome durable before that self-triggered cancel can land: the cron never
 * downgrades a frozen status, so the run stays "failed". Guarded to only
 * advance an in-flight row and never clobber an already-frozen outcome.
 */
export async function markRunFailedOnSelfMove(db: Db, runId: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "failed", updatedAt: sql`now()` })
    .where(
      and(
        eq(workflowRuns.runId, runId),
        // A NULL status is an in-flight row too: `status NOT IN (...)` is NULL
        // (not true) for NULL, so without this a null-status run would be
        // skipped and its failure lost.
        or(
          isNull(workflowRuns.status),
          notInArray(workflowRuns.status, ["success", "failed", "blocked", "awaiting"]),
        ),
      ),
    );
}

/**
 * Commits a run's authoritative "success" status the moment its own
 * success-finalizing AI Review move is about to fire a Jira webhook. The bot
 * moving a finished ticket out of the AI column triggers the "ticket left the
 * AI column" webhook, which would otherwise race in and cancel this
 * still-finalizing run, flipping its world status to "cancelled" (stored as
 * "blocked") even though the PR and ticket move already happened. Recording
 * "success" first makes the outcome durable before that self-triggered cancel
 * can land: the cron never downgrades a frozen status, so the run stays
 * "success". Guarded to only advance an in-flight row and never clobber an
 * already-frozen outcome.
 */
export async function markRunSucceededOnSelfMove(db: Db, runId: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "success", updatedAt: sql`now()` })
    .where(
      and(
        eq(workflowRuns.runId, runId),
        // A NULL status is an in-flight row too: `status NOT IN (...)` is NULL
        // (not true) for NULL, so without this a null-status run would be
        // skipped and its success lost.
        or(
          isNull(workflowRuns.status),
          notInArray(workflowRuns.status, ["success", "failed", "blocked", "awaiting"]),
        ),
      ),
    );
}

/**
 * Flips a run parked on a clarification from "awaiting" to "success". Called
 * when the clarification is answered (or superseded by a re-pickup) so parked
 * runs don't stay "awaiting" forever. Guarded on status='awaiting', so it is a
 * tolerant no-op when the run is missing or already moved on. Returns whether a
 * row actually flipped.
 */
export async function resolveAwaitingRun(db: Db, runId: string): Promise<boolean> {
  const rows = await db
    .update(workflowRuns)
    .set({ status: "success", updatedAt: sql`now()` })
    .where(and(eq(workflowRuns.runId, runId), eq(workflowRuns.status, "awaiting")))
    .returning({ runId: workflowRuns.runId });
  return rows.length > 0;
}

/**
 * Re-pickup housekeeping: flips every OTHER awaiting run for a ticket from
 * "awaiting" to "blocked", excluding the run doing the pickup. A fresh run
 * supersedes its parked predecessors, so those must not stay "awaiting"
 * forever. "blocked" and not "success": a superseded predecessor never got its
 * answer and never finished its work, and the ticket key alone does not prove
 * the row belongs to the same work thread (a pr_trigger run carries it too), so
 * a run still suspended on its own hook would be frozen into a permanent lie.
 * Guarded on status='awaiting' and run_id <> exclude, so it is a tolerant no-op
 * when nothing is parked. Returns the number of rows flipped.
 */
export async function resolveAwaitingRunsForTicket(
  db: Db,
  ticketKey: string,
  excludeRunId: string,
): Promise<number> {
  const rows = await db
    .update(workflowRuns)
    .set({ status: "blocked", updatedAt: sql`now()` })
    .where(
      and(
        eq(workflowRuns.ticketKey, ticketKey),
        eq(workflowRuns.status, "awaiting"),
        ne(workflowRuns.runId, excludeRunId),
      ),
    )
    .returning({ runId: workflowRuns.runId });
  return rows.length;
}

/**
 * Marks a run suspended on a clarification hook as "awaiting" while it is still
 * alive. The workflow body parks inside the hook await, so the outer finally
 * that records a run's own status never runs for a park, and the cron keeps
 * snapshotting the parked run as "running". Unlike the terminal "awaiting" that
 * recordRunUsage writes, this one belongs to a LIVE run, so every exit from the
 * park has to clear it again (markRunResumed, markRunBlockedOnCancel) or the row
 * stays awaiting forever. UPDATE-only on purpose: the row already exists from
 * the run's own registration write, and an INSERT here would create one with no
 * ticket identity. Guarded so an already-frozen outcome is never re-opened.
 */
export async function markRunAwaiting(db: Db, runId: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "awaiting", updatedAt: sql`now()` })
    .where(
      and(
        eq(workflowRuns.runId, runId),
        // A NULL status is an in-flight row too: `status NOT IN (...)` is NULL
        // (not true) for NULL, so without this a run whose row was created by a
        // status-less writer would never be recorded as parked.
        or(
          isNull(workflowRuns.status),
          notInArray(workflowRuns.status, ["failed", "blocked", "success"]),
        ),
      ),
    );
}

/**
 * Clears the live park marker once the answer lands and the parked run carries
 * on, so the dashboard stops reporting it as awaiting input. Guarded on exactly
 * "awaiting": a run that reached "failed", "blocked" or "success" while parked
 * must never be resurrected into "running".
 */
export async function markRunResumed(db: Db, runId: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "running", updatedAt: sql`now()` })
    .where(and(eq(workflowRuns.runId, runId), eq(workflowRuns.status, "awaiting")));
}

/**
 * Clears the live park marker when a parked run is cancelled instead of
 * answered (the ticket is moved out of the AI column while the question is
 * open). The run never resumes to clear it itself and the cron never downgrades
 * a frozen status, so without this the cancelled row keeps showing awaiting
 * input. Guarded on exactly "awaiting" so it only ever touches a parked run.
 */
export async function markRunBlockedOnCancel(db: Db, runId: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "blocked", updatedAt: sql`now()` })
    .where(and(eq(workflowRuns.runId, runId), eq(workflowRuns.status, "awaiting")));
}

/**
 * Settles a run an operator cancelled by run id (cancel-by-id: any in-flight
 * run, including a ticketless webhook or schedule run that no ticket-column
 * cancel path can reach) as "blocked" with the cancellation reason, in one
 * synchronous write. Unlike markRunBlockedOnCancel this also catches a "running"
 * row, because an operator cancel targets a run that is actively executing, not
 * only one parked on a clarification.
 *
 * The guard `status in ('awaiting', 'running')` is only-advance-from-in-flight:
 * it never overwrites a terminal success/failed/blocked, so a run that finished
 * on its own between the operator's click and this write keeps its real outcome
 * (the cron never downgrades a frozen status either). Deliberately separate from
 * markRunBlockedOnCancel so the two clarification-park callers (settleCancelledPark,
 * retireClarificationForGoneTicket) keep the narrower awaiting-only guard and
 * never block a run that legitimately resumed to "running".
 */
export async function markRunBlockedByOperator(
  db: Db,
  runId: string,
  reason: string,
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "blocked", statusReason: reason, updatedAt: sql`now()` })
    .where(
      and(
        eq(workflowRuns.runId, runId),
        inArray(workflowRuns.status, ["awaiting", "running"]),
      ),
    );
}

/**
 * Cron backstop for the live park marker. "awaiting" is frozen against the
 * cron's own snapshot, and every writer that clears it is best-effort, so a
 * single database blip while a park ends leaves a row stuck in "Input needed"
 * that nothing else will ever touch. This settles those orphans on "blocked",
 * the same outcome a cancelled park gets.
 *
 * A run is an orphan only when nothing can still resume it: a healthy park
 * always has a pending clarification (the hook is published before the park is
 * recorded), an answered one is the recoverable "answer stored, resume lost"
 * state the dashboard retries and must stay awaiting, and a pending approval is
 * a human continuation of the same kind. Everything else (superseded, expired,
 * decided, or no continuation at all) has no way back.
 */
export async function sweepOrphanedAwaitingRuns(db: Db): Promise<number> {
  const rows = await db
    .update(workflowRuns)
    .set({ status: "blocked", updatedAt: sql`now()` })
    .where(
      and(
        eq(workflowRuns.status, "awaiting"),
        sql`not exists (
          select 1 from ${clarificationRequests}
          where ${clarificationRequests.runId} = ${workflowRuns.runId}
            and ${clarificationRequests.status} in ('pending', 'answered')
        )`,
        sql`not exists (
          select 1 from ${approvalRequests}
          where ${approvalRequests.runId} = ${workflowRuns.runId}
            and ${approvalRequests.status} = 'pending'
        )`,
      ),
    )
    .returning({ runId: workflowRuns.runId });
  return rows.length;
}
