import type { KpisResponse } from "@shared/contracts";
import type { RunsLister, WorkflowRunRecord } from "./collect-runs.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface CollectKpisOptions {
  runsLister: RunsLister;
  now: Date;
  /**
   * How many recent runs to scan (covers the 48h delta window). The Vercel
   * Workflow `/v2/runs` API rejects `limit > 100` with HTTP 400, so this must
   * stay <= 100 or `runsLister.list` throws and the KPIs degrade to N/A.
   */
  limit?: number;
}

/**
 * Derives the overview KPI tiles from the Vercel Workflow run store. Cost is not
 * tracked by the workflow runtime, so `cost24h` stays null. `runs24h`/`errors24h`
 * count runs by creation time; `p95` is the 95th percentile of completed-run
 * durations. Each tile carries a 24-bucket hourly sparkline and a delta versus
 * the prior 24h window.
 */
export async function collectKpis(
  opts: CollectKpisOptions,
): Promise<Omit<KpisResponse, "generatedAt">> {
  const { runsLister, now } = opts;
  const limit = opts.limit ?? 100;
  const curStart = now.getTime() - DAY;
  const prevStart = now.getTime() - 2 * DAY;

  const { data } = await runsLister.list({
    resolveData: "none",
    pagination: { limit },
  });

  const t = (r: WorkflowRunRecord) => (r.startedAt ?? r.createdAt).getTime();
  const inWindow = (r: WorkflowRunRecord, start: number, end: number) =>
    t(r) >= start && t(r) < end;

  const cur = data.filter((r) => inWindow(r, curStart, now.getTime()));
  const prev = data.filter((r) => inWindow(r, prevStart, curStart));

  const curFailed = cur.filter((r) => r.status === "failed");
  const prevFailed = prev.filter((r) => r.status === "failed");

  const curDurations = durations(cur);
  const prevDurations = durations(prev);
  const curP95 = percentile(curDurations, 95);

  return {
    runs24h: {
      value: cur.length,
      deltaPct: deltaPct(cur.length, prev.length),
      spark: hourlyCounts(cur, curStart),
    },
    p95: {
      valueSec: curP95,
      deltaSec: curP95 - percentile(prevDurations, 95),
      spark: hourlyP95(cur, curStart),
    },
    errors24h: {
      value: curFailed.length,
      deltaPct: deltaPct(curFailed.length, prevFailed.length),
      spark: hourlyCounts(curFailed, curStart),
    },
    // Per-run cost is not tracked by the workflow runtime.
    cost24h: null,
  };
}

function durations(runs: WorkflowRunRecord[]): number[] {
  const out: number[] = [];
  for (const r of runs) {
    const start = r.startedAt ?? r.createdAt;
    if (r.completedAt) {
      out.push(Math.max(0, Math.round((r.completedAt.getTime() - start.getTime()) / 1000)));
    }
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function deltaPct(cur: number, prev: number): number {
  if (prev === 0) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function bucketOf(r: WorkflowRunRecord, windowStart: number): number {
  const ts = (r.startedAt ?? r.createdAt).getTime();
  return Math.max(0, Math.min(23, Math.floor((ts - windowStart) / HOUR)));
}

function hourlyCounts(runs: WorkflowRunRecord[], windowStart: number): number[] {
  const buckets = new Array(24).fill(0);
  for (const r of runs) buckets[bucketOf(r, windowStart)] += 1;
  return buckets;
}

function hourlyP95(runs: WorkflowRunRecord[], windowStart: number): number[] {
  const perHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const r of runs) {
    const start = r.startedAt ?? r.createdAt;
    if (r.completedAt) {
      perHour[bucketOf(r, windowStart)].push(
        Math.max(0, Math.round((r.completedAt.getTime() - start.getTime()) / 1000)),
      );
    }
  }
  return perHour.map((d) => percentile(d, 95));
}
