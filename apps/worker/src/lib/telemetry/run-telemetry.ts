import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { workflowRuns } from "../../db/schema.js";

/**
 * Lifecycle/status fields the poll cron snapshots from the Workflow world and
 * the run registry. Authoritative for status & timing; ticket/PR fields are
 * best-effort (a flaky Jira/gate lookup one cycle must not erase a good value
 * from a previous cycle — see the COALESCE set below).
 */
export interface RunSnapshot {
  runId: string;
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
  prUrl: string | null;
  prNumber: number | null;
}

/** `coalesce(excluded.<col>, "workflow_runs"."<col>")` — take the incoming
 * value when present, otherwise keep what's already stored. */
function keepIfNull(column: { name: string }, existing: unknown) {
  return sql`coalesce(excluded.${sql.raw(column.name)}, ${existing})`;
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
        status: sql`excluded.status`,
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
 * Workflow writer. Upserts the cost/usage (and agent PR) for one run, setting
 * only its own columns. PR uses COALESCE so it never erases a gate PR a cron
 * snapshot may have recorded for the same row.
 */
export async function recordRunUsage(db: Db, usage: RunUsage): Promise<void> {
  await db
    .insert(workflowRuns)
    .values({
      runId: usage.runId,
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
      prUrl: usage.prUrl,
      prNumber: usage.prNumber,
    })
    .onConflictDoUpdate({
      target: workflowRuns.runId,
      set: {
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
        prUrl: keepIfNull(workflowRuns.prUrl, workflowRuns.prUrl),
        prNumber: keepIfNull(workflowRuns.prNumber, workflowRuns.prNumber),
        updatedAt: sql`now()`,
      },
    });
}
