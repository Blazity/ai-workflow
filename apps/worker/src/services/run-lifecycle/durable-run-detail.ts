import type {
  RunAnalysisReport,
  RunDetail,
  RunFailureCode,
  RunPullRequest,
  RunStep,
} from "@shared/contracts";
import { isRunFailureCode } from "@shared/contracts";
import type { Db } from "../../db/types.js";
import {
  readConnectedRunDetailRow,
  readConnectedRunRefsRow,
  readRunDetailRow,
  readRunRefsRow,
} from "../../db/repositories/runs.js";
import { parseStoredRunAnalysisReport } from "../../db/repositories/runs/analysis-report.js";
import { coerceStatus } from "./dashboard-run-data.js";
import { attributeRunModel, sanitizeRunSteps } from "../overview/index.js";

const PHASE_ORDER = ["Setup", "Research", "Implementation", "Review", "Finalize", "Run"];
const TERMINAL = new Set(["success", "failed", "blocked", "awaiting"]);

function normalizeFinishedSteps(steps: RunStep[], completedAtIso: string | null): RunStep[] {
  return steps.map((step) => {
    if (step.status !== "running" && step.status !== "pending") return step;
    const completedAt = step.completedAt ?? completedAtIso;
    const durationMs = step.durationMs ?? (step.startedAt && completedAt
      ? Math.max(0, new Date(completedAt).getTime() - new Date(step.startedAt).getTime())
      : null);
    return { ...step, status: "completed" as const, completedAt, durationMs };
  });
}

function phaseRank(name: string): number {
  const index = PHASE_ORDER.indexOf(name);
  return index === -1 ? PHASE_ORDER.length : index;
}

function phasesToSteps(phases: unknown, base: Date): RunStep[] {
  if (!phases || typeof phases !== "object") return [];
  const entries = Object.entries(phases as Record<string, { durationMs?: unknown }>);
  entries.sort(([left], [right]) => phaseRank(left) - phaseRank(right));
  const baseMs = base.getTime();
  let offset = 0;
  return entries.map(([name, value]) => {
    const durationMs = typeof value?.durationMs === "number" && value.durationMs >= 0
      ? value.durationMs
      : null;
    const startOffsetMs = offset;
    const startMs = baseMs + offset;
    if (durationMs !== null) offset += durationMs;
    return {
      stepId: `phase:${name}`,
      name,
      rawName: name,
      status: "completed" as const,
      attempt: 1,
      createdAt: new Date(startMs).toISOString(),
      startedAt: new Date(startMs).toISOString(),
      completedAt: durationMs !== null ? new Date(startMs + durationMs).toISOString() : null,
      startOffsetMs,
      durationMs,
      error: null,
    };
  });
}

export interface FetchRunDetailFromDbOptions {
  db: Db;
  runId: string;
  ticketOrigin: string;
}

/**
 * `failureCode` travels BESIDE the run rather than inside it, which is what
 * ADR-010 decided in S4: the durable column is the machine's answer, the
 * dashboard payload is built field by field and does not carry it, and MCP is
 * its first consumer. A field on RunDetail would have put it into every client
 * of the run detail route on the way to one reader.
 */
function mapRunDetailRow(
  row: NonNullable<Awaited<ReturnType<typeof readRunDetailRow>>>,
  ticketOrigin: string,
): {
  run: RunDetail;
  steps: RunStep[];
  hasRealSteps: boolean;
  analysisReport: RunAnalysisReport | null;
  failureCode: RunFailureCode | null;
} {
  const tenantOrigin = ticketOrigin.replace(/\/+$/, "");
  const base = row.startedAt ?? row.createdAt ?? row.firstSeenAt;
  const status = coerceStatus(row.status);
  const run: RunDetail = {
    id: row.runId,
    workflow: row.workflowId ?? "wf_unknown",
    workflowName: row.workflowName ?? row.workflowId ?? "\u2014",
    status,
    ticket: row.ticketKey ?? "",
    ticketTitle: row.ticketTitle ?? row.ticketKey ?? "",
    ticketUrl: row.ticketUrl ?? (row.ticketKey ? `${tenantOrigin}/browse/${row.ticketKey}` : ""),
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    prs: row.prs,
    model: attributeRunModel(row),
    createdAt: (row.createdAt ?? row.firstSeenAt).toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationSec: row.durationSec,
    // cost_known is nullable with no default and recordRunUsage is its only
    // writer (it always supplies a boolean, true or false), so "not null" is an
    // exact answer to "has the end-of-run telemetry write landed?".
    usageRecorded: row.costKnown !== null,
    error: row.statusReason && (status === "blocked" || status === "failed")
      ? { message: row.statusReason }
      : null,
    statusReason: row.statusReason,
    repositoryAccess: row.repositoryAccess ?? null,
    deploymentId: null,
  };
  const persisted = Array.isArray(row.steps) ? (row.steps as RunStep[]) : null;
  const analysisReport = parseStoredRunAnalysisReport(row.analysisReport);
  // Null for every run that failed before the column existed, and null means
  // "this failure carries no code", never "unknown failure".
  const failureCode = isRunFailureCode(row.statusReasonCode) ? row.statusReasonCode : null;
  if (persisted && persisted.length > 0) {
    const safePersisted = sanitizeRunSteps(persisted) ?? [];
    const steps = TERMINAL.has(run.status)
      ? normalizeFinishedSteps(safePersisted, run.completedAt)
      : safePersisted;
    return { run, steps, hasRealSteps: true, analysisReport, failureCode };
  }
  return {
    run,
    steps: phasesToSteps(row.phases, base),
    hasRealSteps: false,
    analysisReport,
    failureCode,
  };
}

export async function fetchRunDetailFromDb(opts: FetchRunDetailFromDbOptions) {
  const row = await readRunDetailRow(opts.db, opts.runId);
  return row ? mapRunDetailRow(row, opts.ticketOrigin) : null;
}

export async function fetchConnectedRunDetailFromDb(
  opts: Omit<FetchRunDetailFromDbOptions, "db">,
) {
  const row = await readConnectedRunDetailRow(opts.runId);
  return row ? mapRunDetailRow(row, opts.ticketOrigin) : null;
}

function mapRunRefs(
  row: NonNullable<Awaited<ReturnType<typeof readRunRefsRow>>>,
  ticketOrigin: string,
): {
  ticketKey: string | null;
  ticketUrl: string | null;
  ticketTitle: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prs: RunPullRequest[] | null;
  statusReason: string | null;
} {
  const tenantOrigin = ticketOrigin.replace(/\/+$/, "");
  return {
    ...row,
    ticketUrl: row.ticketUrl ?? (row.ticketKey ? `${tenantOrigin}/browse/${row.ticketKey}` : null),
  };
}

export async function fetchRunRefs(db: Db, runId: string, ticketOrigin: string) {
  const row = await readRunRefsRow(db, runId);
  return row ? mapRunRefs(row, ticketOrigin) : null;
}

export async function fetchConnectedRunRefs(runId: string, ticketOrigin: string) {
  const row = await readConnectedRunRefsRow(runId);
  return row ? mapRunRefs(row, ticketOrigin) : null;
}
