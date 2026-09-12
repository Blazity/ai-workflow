import { and, count, eq, sql, type SQL } from "drizzle-orm";
import type { RunPullRequest } from "@shared/contracts";
import { getDb, type Db } from "../../client.js";
import { workflowRuns } from "../../schema.js";

export interface DashboardRunRow {
  runId: string;
  workflowId: string | null;
  workflowName: string | null;
  status: string | null;
  statusReason: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  model: string | null;
  startedAt: Date | null;
  firstSeenAt: Date;
  durationSec: number | null;
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  prNumber: number | null;
  prUrl: string | null;
  prs: RunPullRequest[] | null;
}

const runColumns = {
  runId: workflowRuns.runId,
  workflowId: workflowRuns.workflowId,
  workflowName: workflowRuns.workflowName,
  status: workflowRuns.status,
  statusReason: workflowRuns.statusReason,
  ticketKey: workflowRuns.ticketKey,
  ticketTitle: workflowRuns.ticketTitle,
  ticketUrl: workflowRuns.ticketUrl,
  model: workflowRuns.model,
  startedAt: workflowRuns.startedAt,
  firstSeenAt: workflowRuns.firstSeenAt,
  durationSec: workflowRuns.durationSec,
  costUsd: workflowRuns.costUsd,
  tokensInput: workflowRuns.tokensInput,
  tokensOutput: workflowRuns.tokensOutput,
  prNumber: workflowRuns.prNumber,
  prUrl: workflowRuns.prUrl,
  prs: workflowRuns.prs,
} as const;

function effectiveTime(): SQL {
  return sql`coalesce(${workflowRuns.startedAt}, ${workflowRuns.firstSeenAt})`;
}

function conditions(input: { cutoff: Date | null; q?: string | null }): SQL | undefined {
  const values: SQL[] = [];
  if (input.cutoff) values.push(sql`${effectiveTime()} >= ${input.cutoff.toISOString()}::timestamptz`);
  if (input.q) {
    const pattern = `%${input.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    values.push(sql`(${workflowRuns.ticketKey} ilike ${pattern} or ${workflowRuns.ticketTitle} ilike ${pattern})`);
  }
  return values.length > 0 ? and(...values) : undefined;
}

export function listDashboardRunRows(
  db: Db,
  input: { cutoff: Date | null; q: string | null; limit: number },
): Promise<DashboardRunRow[]> {
  return db.select(runColumns).from(workflowRuns)
    .where(conditions(input)).orderBy(sql`${effectiveTime()} desc`).limit(input.limit);
}

export function countDashboardRunRowsByStatus(
  db: Db,
  input: { cutoff: Date | null; q: string | null },
) {
  return db.select({ status: workflowRuns.status, n: count() }).from(workflowRuns)
    .where(conditions(input)).groupBy(workflowRuns.status);
}

export function listRunKpiRows(db: Db, cutoff: Date | null) {
  return db.select({
    startedAt: workflowRuns.startedAt,
    firstSeenAt: workflowRuns.firstSeenAt,
    status: workflowRuns.status,
    durationSec: workflowRuns.durationSec,
    costUsd: workflowRuns.costUsd,
  }).from(workflowRuns)
    .where(cutoff ? sql`${effectiveTime()} >= ${cutoff.toISOString()}::timestamptz` : undefined);
}

export function listWorkflowAggregateRows(db: Db, cutoff: Date | null) {
  return db.select({
    workflowId: workflowRuns.workflowId,
    status: workflowRuns.status,
    durationSec: workflowRuns.durationSec,
    costUsd: workflowRuns.costUsd,
    startedAt: workflowRuns.startedAt,
    firstSeenAt: workflowRuns.firstSeenAt,
  }).from(workflowRuns)
    .where(cutoff ? sql`${effectiveTime()} >= ${cutoff.toISOString()}::timestamptz` : undefined);
}

export function listLatestWorkflowRunRows(db: Db) {
  return db.selectDistinctOn([workflowRuns.workflowId], {
    workflowId: workflowRuns.workflowId,
    ticketKey: workflowRuns.ticketKey,
    ticketTitle: workflowRuns.ticketTitle,
    ticketUrl: workflowRuns.ticketUrl,
    prNumber: workflowRuns.prNumber,
    prUrl: workflowRuns.prUrl,
    prs: workflowRuns.prs,
  }).from(workflowRuns).orderBy(workflowRuns.workflowId, sql`${effectiveTime()} desc`);
}

export function listCostAggregateRows(db: Db, cutoff: Date | null) {
  return db.select({
    workflowId: workflowRuns.workflowId,
    workflowName: workflowRuns.workflowName,
    costUsd: workflowRuns.costUsd,
    tokensInput: workflowRuns.tokensInput,
    tokensOutput: workflowRuns.tokensOutput,
    startedAt: workflowRuns.startedAt,
    firstSeenAt: workflowRuns.firstSeenAt,
  }).from(workflowRuns)
    .where(cutoff ? sql`${effectiveTime()} >= ${cutoff.toISOString()}::timestamptz` : undefined);
}

export function listTicketRunRows(db: Db, ticketKey: string): Promise<DashboardRunRow[]> {
  return db.select(runColumns).from(workflowRuns)
    .where(eq(workflowRuns.ticketKey, ticketKey)).orderBy(sql`${effectiveTime()} desc`);
}

export const connectedDashboardRunQueries = {
  listRuns: (input: Parameters<typeof listDashboardRunRows>[1]) => listDashboardRunRows(getDb(), input),
  countRuns: (input: Parameters<typeof countDashboardRunRowsByStatus>[1]) => countDashboardRunRowsByStatus(getDb(), input),
  listKpis: (cutoff: Date | null) => listRunKpiRows(getDb(), cutoff),
  listWorkflowRows: (cutoff: Date | null) => listWorkflowAggregateRows(getDb(), cutoff),
  listLatestWorkflowRows: () => listLatestWorkflowRunRows(getDb()),
  listCosts: (cutoff: Date | null) => listCostAggregateRows(getDb(), cutoff),
  listTicketRuns: (ticketKey: string) => listTicketRunRows(getDb(), ticketKey),
};
