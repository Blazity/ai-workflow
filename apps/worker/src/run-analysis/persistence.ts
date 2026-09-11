import type { RunAnalysisReport, RunAnalysisUsageSnapshot } from "@shared/contracts";
import { parseStoredRunAnalysisReport } from "../db/repositories/runs/analysis-report.js";
import {
  insertConnectedRunAnalysisReportIfAbsent,
  insertRunAnalysisReportIfAbsent,
  readConnectedStoredRunAnalysisReport,
  readStoredRunAnalysisReport,
  replaceConnectedRunAnalysisReportIfUnchanged,
  replaceRunAnalysisReportIfUnchanged,
} from "../db/repositories/runs/run-analysis.js";

const MAX_REPORT_WRITE_ATTEMPTS = 8;

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

type RunAnalysisStatements = {
  read(runId: string): Promise<{ analysisReport: unknown | null } | null>;
  replace(input: {
    runId: string;
    current: unknown | null;
    next: RunAnalysisReport;
  }): Promise<boolean>;
  insert(report: RunAnalysisReport): Promise<boolean>;
};

function newerDelivery(
  current: RunAnalysisReport["jira"]["research"],
  incoming: RunAnalysisReport["jira"]["research"],
): RunAnalysisReport["jira"]["research"] {
  return deliveryRank[incoming.state] >= deliveryRank[current.state]
    ? incoming
    : current;
}

/** Merge forward-moving lifecycle slots so durable replays cannot erase later state. */
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

function statementsForDb(
  db: Parameters<typeof readStoredRunAnalysisReport>[0],
): RunAnalysisStatements {
  return {
    read: (runId) => readStoredRunAnalysisReport(db, runId),
    replace: (input) => replaceRunAnalysisReportIfUnchanged(db, input),
    insert: (report) => insertRunAnalysisReportIfAbsent(db, report),
  };
}

const connectedStatements: RunAnalysisStatements = {
  read: readConnectedStoredRunAnalysisReport,
  replace: replaceConnectedRunAnalysisReportIfUnchanged,
  insert: insertConnectedRunAnalysisReportIfAbsent,
};

async function recordRunAnalysisReportWithStatements(
  statements: RunAnalysisStatements,
  report: RunAnalysisReport,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_REPORT_WRITE_ATTEMPTS; attempt += 1) {
    const stored = await statements.read(report.runId);
    const merged = mergeRunAnalysisReports(
      parseStoredRunAnalysisReport(stored?.analysisReport),
      report,
    );
    if (stored !== null) {
      if (await statements.replace({
        runId: report.runId,
        current: stored.analysisReport,
        next: merged,
      })) {
        return;
      }
      continue;
    }
    if (await statements.insert(merged)) return;
  }
  throw new Error(
    `Could not persist run analysis report for ${report.runId} after ${MAX_REPORT_WRITE_ATTEMPTS} attempts`,
  );
}

export function recordRunAnalysisReport(
  db: Parameters<typeof readStoredRunAnalysisReport>[0],
  report: RunAnalysisReport,
): Promise<void> {
  return recordRunAnalysisReportWithStatements(statementsForDb(db), report);
}

export function recordConnectedRunAnalysisReport(
  report: RunAnalysisReport,
): Promise<void> {
  return recordRunAnalysisReportWithStatements(connectedStatements, report);
}

async function getRunAnalysisReportWithStatements(
  statements: RunAnalysisStatements,
  runId: string,
): Promise<RunAnalysisReport | null> {
  return parseStoredRunAnalysisReport(
    (await statements.read(runId))?.analysisReport,
  );
}

export function getRunAnalysisReport(
  db: Parameters<typeof readStoredRunAnalysisReport>[0],
  runId: string,
): Promise<RunAnalysisReport | null> {
  return getRunAnalysisReportWithStatements(statementsForDb(db), runId);
}

export function getConnectedRunAnalysisReport(
  runId: string,
): Promise<RunAnalysisReport | null> {
  return getRunAnalysisReportWithStatements(connectedStatements, runId);
}

async function finalizeRunAnalysisUsageWithStatements(
  statements: RunAnalysisStatements,
  runId: string,
  finalUsage: RunAnalysisUsageSnapshot,
): Promise<void> {
  const current = await getRunAnalysisReportWithStatements(statements, runId);
  if (!current) return;
  await recordRunAnalysisReportWithStatements(statements, {
    ...current,
    usage: { ...current.usage, final: finalUsage },
  });
}

export function finalizeRunAnalysisUsage(
  db: Parameters<typeof readStoredRunAnalysisReport>[0],
  runId: string,
  finalUsage: RunAnalysisUsageSnapshot,
): Promise<void> {
  return finalizeRunAnalysisUsageWithStatements(
    statementsForDb(db),
    runId,
    finalUsage,
  );
}

export function finalizeConnectedRunAnalysisUsage(
  runId: string,
  finalUsage: RunAnalysisUsageSnapshot,
): Promise<void> {
  return finalizeRunAnalysisUsageWithStatements(
    connectedStatements,
    runId,
    finalUsage,
  );
}
