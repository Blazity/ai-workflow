import { and, eq, isNull, sql } from "drizzle-orm";
import type { RunAnalysisReport } from "@shared/contracts";
import { getDb, type Db } from "../../client.js";
import { workflowRuns } from "../../schema.js";

function jsonbValue(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

/** Raw JSONB read. Parsing and report lifecycle decisions belong above DB. */
export async function readStoredRunAnalysisReport(
  db: Db,
  runId: string,
): Promise<{ analysisReport: unknown | null } | null> {
  const [row] = await db
    .select({ analysisReport: workflowRuns.analysisReport })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return row ?? null;
}

/** One JSONB compare-and-swap statement for a report snapshot. */
export async function replaceRunAnalysisReportIfUnchanged(
  db: Db,
  input: {
    runId: string;
    current: unknown | null;
    next: RunAnalysisReport;
  },
): Promise<boolean> {
  const snapshotCondition = input.current === null
    ? isNull(workflowRuns.analysisReport)
    : sql`${workflowRuns.analysisReport} is not distinct from ${jsonbValue(input.current)}`;
  const [updated] = await db
    .update(workflowRuns)
    .set({ analysisReport: input.next, updatedAt: sql`now()` })
    .where(and(eq(workflowRuns.runId, input.runId), snapshotCondition))
    .returning({ runId: workflowRuns.runId });
  return updated !== undefined;
}

/** One insert-if-absent statement for the first report written for a run. */
export async function insertRunAnalysisReportIfAbsent(
  db: Db,
  report: RunAnalysisReport,
): Promise<boolean> {
  const [inserted] = await db
    .insert(workflowRuns)
    .values({
      runId: report.runId,
      workflowId: "wf_agent",
      workflowName: "Agent",
      analysisReport: report,
    })
    .onConflictDoNothing({ target: workflowRuns.runId })
    .returning({ runId: workflowRuns.runId });
  return inserted !== undefined;
}

export function readConnectedStoredRunAnalysisReport(
  runId: string,
): Promise<{ analysisReport: unknown | null } | null> {
  return readStoredRunAnalysisReport(getDb(), runId);
}

export function replaceConnectedRunAnalysisReportIfUnchanged(
  input: Parameters<typeof replaceRunAnalysisReportIfUnchanged>[1],
): Promise<boolean> {
  return replaceRunAnalysisReportIfUnchanged(getDb(), input);
}

export function insertConnectedRunAnalysisReportIfAbsent(
  report: RunAnalysisReport,
): Promise<boolean> {
  return insertRunAnalysisReportIfAbsent(getDb(), report);
}
