import { getWorkflowRegistry } from "./workflow-registry.js";
import { collectRuns, type CollectRunsOptions } from "./collect-runs.js";
import { percentile } from "./collect-kpis.js";
import type { Run, WorkflowRow } from "@shared/contracts";

export interface CollectWorkflowsResult {
  rows: WorkflowRow[];
  total: number;
}

/** Same inputs as the recent-runs collector — the metrics are aggregated from it. */
export type CollectWorkflowsOptions = CollectRunsOptions;

const DAY_MIN = 24 * 60;

/**
 * The static registry widened to `WorkflowRow` with `null` metric fields. Used
 * as the degraded view when the run store can't be reached (e.g. local dev
 * without the Vercel runtime) — the card still lists the workflows.
 */
export function registryRows(): CollectWorkflowsResult {
  const rows: WorkflowRow[] = getWorkflowRegistry().map((w) => ({
    id: w.id,
    name: w.name,
    blurb: w.blurb,
    gateway: w.gateway,
    primary: w.primary,
    runs24h: null,
    p50: null,
    p95: null,
    errRate: null,
    costToday: null,
    latestRun: null,
    trend24h: null,
  }));
  return { rows, total: rows.length };
}

/**
 * Builds the Workflows table by aggregating the recent-runs list per workflow
 * over a 24h window. Identity comes from the static registry; metrics come from
 * the run store. Per-run cost isn't tracked by the workflow runtime, so
 * `costToday` stays null. A workflow with no runs in the window reports 0 runs
 * and null latency/error/trend (rendered as "—"); `latestRun` is the most recent
 * run regardless of window, so the latest ticket persists past 24h.
 */
export async function collectWorkflows(
  opts: CollectWorkflowsOptions,
): Promise<CollectWorkflowsResult> {
  // Newest-first. Propagates a run-store failure to the route, which degrades
  // to `registryRows()` — matching how the sibling collectors are wrapped.
  const { rows: runs } = await collectRuns(opts);

  const recent = runs.filter((r) => r.startedAtMin < DAY_MIN);
  const byWorkflow = new Map<string, Run[]>();
  for (const r of recent) {
    const list = byWorkflow.get(r.workflow) ?? [];
    list.push(r);
    byWorkflow.set(r.workflow, list);
  }

  const rows: WorkflowRow[] = getWorkflowRegistry().map((w) => {
    const wfRuns = byWorkflow.get(w.id) ?? [];
    const durations = wfRuns
      .map((r) => r.duration)
      .filter((d): d is number => d !== null);
    const failed = wfRuns.filter((r) => r.status === "failed").length;
    const latest = runs.find((r) => r.workflow === w.id) ?? null;

    return {
      id: w.id,
      name: w.name,
      blurb: w.blurb,
      gateway: w.gateway,
      primary: w.primary,
      runs24h: wfRuns.length,
      p50: durations.length ? percentile(durations, 50) : null,
      p95: durations.length ? percentile(durations, 95) : null,
      errRate: wfRuns.length ? failed / wfRuns.length : null,
      // Per-run cost is not tracked by the workflow runtime.
      costToday: null,
      latestRun: latest
        ? {
            ticket: latest.ticket,
            ticketUrl: latest.ticketUrl,
            ticketTitle: latest.ticketTitle,
            prNumber: latest.prNumber,
            prUrl: latest.prUrl,
          }
        : null,
      trend24h: wfRuns.length ? hourlyCounts(wfRuns) : null,
    };
  });

  return { rows, total: rows.length };
}

/** 24 hourly buckets, oldest→newest, from each run's `startedAtMin` (matches the KPI sparklines). */
function hourlyCounts(runs: Run[]): number[] {
  const buckets = new Array(24).fill(0);
  for (const r of runs) {
    const idx = Math.max(0, Math.min(23, 23 - Math.floor(r.startedAtMin / 60)));
    buckets[idx] += 1;
  }
  return buckets;
}
