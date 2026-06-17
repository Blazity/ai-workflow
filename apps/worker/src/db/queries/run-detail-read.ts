import { eq } from "drizzle-orm";
import type { RunDetail, RunStep } from "@shared/contracts";
import type { Db } from "../client.js";
import { workflowRuns } from "../schema.js";
import { coerceStatus } from "./runs-read.js";

/**
 * Postgres fallback for the single-run trace. The Vercel Workflow step waterfall
 * is only available for ~24h; once a run expires the world lookup throws and the
 * trace screen would go blank. `workflow_runs` keeps a durable record, so we
 * rebuild the header from it and synthesize a coarse phase waterfall from the
 * persisted `phases` breakdown ({ [phase]: { costUsd, tokens, durationMs, ... } }).
 *
 * Returns null when the run id is unknown, letting the route fall through to its
 * documented empty state.
 */

const PHASE_ORDER = ["Setup", "Research", "Implementation", "Review", "Finalize", "Run"];

function phaseRank(name: string): number {
  const i = PHASE_ORDER.indexOf(name);
  return i === -1 ? PHASE_ORDER.length : i;
}

interface PhaseEntry {
  durationMs?: unknown;
}

/** Build sequential phase pseudo-steps from the persisted `phases` jsonb. */
function phasesToSteps(phases: unknown, base: Date): RunStep[] {
  if (!phases || typeof phases !== "object") return [];
  const entries = Object.entries(phases as Record<string, PhaseEntry>);
  entries.sort(([a], [b]) => phaseRank(a) - phaseRank(b));

  const baseMs = base.getTime();
  let offset = 0;
  return entries.map(([name, value]): RunStep => {
    const durationMs =
      typeof value?.durationMs === "number" && value.durationMs >= 0
        ? value.durationMs
        : null;
    const startOffsetMs = offset;
    const startMs = baseMs + offset;
    if (durationMs != null) offset += durationMs;
    return {
      stepId: `phase:${name}`,
      name,
      rawName: name,
      status: "completed",
      attempt: 1,
      createdAt: new Date(startMs).toISOString(),
      startedAt: new Date(startMs).toISOString(),
      completedAt: durationMs != null ? new Date(startMs + durationMs).toISOString() : null,
      startOffsetMs,
      durationMs,
      error: null,
    };
  });
}

export interface FetchRunDetailFromDbOptions {
  db: Db;
  runId: string;
  jiraBaseUrl: string;
  modelFallback: string;
}

export async function fetchRunDetailFromDb(
  opts: FetchRunDetailFromDbOptions,
): Promise<{ run: RunDetail; steps: RunStep[] } | null> {
  const { db, runId, jiraBaseUrl, modelFallback } = opts;
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  const [row] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  if (!row) return null;

  const base = row.startedAt ?? row.createdAt ?? row.firstSeenAt;

  const run: RunDetail = {
    id: row.runId,
    workflow: row.workflowId ?? "wf_unknown",
    workflowName: row.workflowName ?? row.workflowId ?? "—",
    status: coerceStatus(row.status),
    ticket: row.ticketKey ?? "",
    ticketTitle: row.ticketTitle ?? row.ticketKey ?? "",
    ticketUrl:
      row.ticketUrl ?? (row.ticketKey ? `${tenantOrigin}/browse/${row.ticketKey}` : ""),
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    model: row.model ?? modelFallback,
    createdAt: (row.createdAt ?? row.firstSeenAt).toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationSec: row.durationSec,
    error: null,
    deploymentId: null,
  };

  return { run, steps: phasesToSteps(row.phases, base) };
}

/**
 * Just the PR ref for a run, from the durable telemetry. The Workflow world has
 * no PR, so the live trace path enriches its world-built header with this. Null
 * when the run isn't in the table yet (its PR is recorded on completion).
 */
export async function fetchRunPr(
  db: Db,
  runId: string,
): Promise<{ prNumber: number | null; prUrl: string | null } | null> {
  const [row] = await db
    .select({ prNumber: workflowRuns.prNumber, prUrl: workflowRuns.prUrl })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return row ?? null;
}
