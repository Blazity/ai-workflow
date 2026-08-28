import { and, eq, isNull, sql } from "drizzle-orm";
import type { RunAnalysisReport, RunAnalysisUsageSnapshot } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { parseStoredRunAnalysisReport } from "./report.js";

const stageRank = {
  research_complete: 1,
  no_change: 2,
  published: 3,
} as const;

const deliveryRank = {
  not_applicable: 0,
  pending: 1,
  failed: 2,
  posted: 3,
} as const;

const MAX_REPORT_WRITE_ATTEMPTS = 8;

function jsonbValue(value: unknown) {
  return sql`${JSON.stringify(value ?? null)}::jsonb`;
}

function newerDelivery(
  current: RunAnalysisReport["jira"]["research"],
  incoming: RunAnalysisReport["jira"]["research"],
): RunAnalysisReport["jira"]["research"] {
  return deliveryRank[incoming.state] >= deliveryRank[current.state]
    ? incoming
    : current;
}

/** Merge only forward-moving lifecycle slots so a durable replay of an older
 * snapshot cannot erase publication, delivery, or final-usage state. */
export function mergeRunAnalysisReports(
  current: RunAnalysisReport | null,
  incoming: RunAnalysisReport,
): RunAnalysisReport {
  if (!current || current.runId !== incoming.runId) return incoming;
  const researchBase = incoming.researchRevision >= current.researchRevision
    ? incoming
    : current;
  const incomingSanitizationIsNewer =
    incoming.researchRevision > current.researchRevision ||
    incoming.sanitization.originalBytes > current.sanitization.originalBytes ||
    (incoming.sanitization.originalBytes === current.sanitization.originalBytes &&
      incoming.sanitization.storedBytes >= current.sanitization.storedBytes);
  return {
    ...researchBase,
    stage:
      stageRank[incoming.stage] >= stageRank[current.stage]
        ? incoming.stage
        : current.stage,
    publication: incoming.publication ?? current.publication,
    usage: {
      research: researchBase.usage.research,
      publication: incoming.usage.publication ?? current.usage.publication,
      final: incoming.usage.final ?? current.usage.final,
    },
    jira: {
      research: newerDelivery(current.jira.research, incoming.jira.research),
      pullRequest: newerDelivery(current.jira.pullRequest, incoming.jira.pullRequest),
    },
    sanitization: incomingSanitizationIsNewer
      ? incoming.sanitization
      : current.sanitization,
  };
}

/** Persist one report without claiming ownership of any other workflow_runs
 * columns. The insert identity mirrors the agent telemetry writer so research
 * can be recorded before a cron snapshot or terminal usage write exists. */
export async function recordRunAnalysisReport(
  db: Db,
  report: RunAnalysisReport,
): Promise<void> {
  // neon-http does not support interactive transactions. Compare-and-swap the
  // exact JSONB snapshot that was merged so a concurrent writer cannot be
  // overwritten; a conflicting insert follows the same retry path.
  for (let attempt = 0; attempt < MAX_REPORT_WRITE_ATTEMPTS; attempt += 1) {
    const [row] = await db
      .select({ analysisReport: workflowRuns.analysisReport })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, report.runId))
      .limit(1);
    const merged = mergeRunAnalysisReports(
      parseStoredRunAnalysisReport(row?.analysisReport),
      report,
    );
    if (row) {
      const snapshotCondition = row.analysisReport === null
        ? isNull(workflowRuns.analysisReport)
        : sql`${workflowRuns.analysisReport} is not distinct from ${jsonbValue(row.analysisReport)}`;
      const [updated] = await db
        .update(workflowRuns)
        .set({ analysisReport: merged, updatedAt: sql`now()` })
        .where(
          and(
            eq(workflowRuns.runId, report.runId),
            snapshotCondition,
          ),
        )
        .returning({ runId: workflowRuns.runId });
      if (updated) return;
      continue;
    }

    const [inserted] = await db
      .insert(workflowRuns)
      .values({
        runId: report.runId,
        workflowId: "wf_agent",
        workflowName: "Agent",
        analysisReport: merged,
      })
      .onConflictDoNothing({ target: workflowRuns.runId })
      .returning({ runId: workflowRuns.runId });
    if (inserted) return;
  }

  throw new Error(
    `Could not persist run analysis report for ${report.runId} after ${MAX_REPORT_WRITE_ATTEMPTS} attempts`,
  );
}

/** Read JSONB through the structural parser; callers never trust a cast from
 * the database because legacy/corrupt rows must behave like a missing report. */
export async function getRunAnalysisReport(
  db: Db,
  runId: string,
): Promise<RunAnalysisReport | null> {
  const [row] = await db
    .select({ analysisReport: workflowRuns.analysisReport })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return parseStoredRunAnalysisReport(row?.analysisReport);
}

/** Add the authoritative terminal usage snapshot after recordRunUsage. This
 * intentionally updates only the nested final slot and leaves Jira delivery
 * plus earlier research/publication snapshots untouched. */
export async function finalizeRunAnalysisUsage(
  db: Db,
  runId: string,
  finalUsage: RunAnalysisUsageSnapshot,
): Promise<void> {
  const current = await getRunAnalysisReport(db, runId);
  if (!current) return;
  const next: RunAnalysisReport = {
    ...current,
    usage: { ...current.usage, final: finalUsage },
  };
  await recordRunAnalysisReport(db, next);
}
