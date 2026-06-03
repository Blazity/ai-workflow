import type { KpisResponse, RunsResponse } from "@shared/contracts";

const DAY_MIN = 24 * 60;

/**
 * Fallback KPI derivation from the runs list. The worker's `/overview/kpis`
 * endpoint returns `null` whenever its run-store page exceeds the Vercel
 * Workflow API's `limit` cap; when that happens we reconstruct the tiles from
 * the (already-fetched) runs list instead. Cost is not tracked per run, so
 * `cost24h` stays null. The runs list is capped at one page (~50 rows), so the
 * 48h delta window is best-effort — `deltaPct`/`deltaSec` are 0 when the prior
 * window isn't covered by that page.
 */
export function deriveKpisFromRuns(
  runs: RunsResponse,
  generatedAt: string,
): KpisResponse {
  const cur = runs.rows.filter((r) => r.startedAtMin < DAY_MIN);
  const prev = runs.rows.filter(
    (r) => r.startedAtMin >= DAY_MIN && r.startedAtMin < 2 * DAY_MIN,
  );

  const curFailed = cur.filter((r) => r.status === "failed");
  const prevFailed = prev.filter((r) => r.status === "failed");

  const curDur = durations(cur);
  const curP95 = percentile(curDur, 95);

  return {
    generatedAt,
    runs24h: {
      value: cur.length,
      deltaPct: deltaPct(cur.length, prev.length),
      spark: hourlyCounts(cur),
    },
    p95: {
      valueSec: curP95,
      deltaSec: curP95 - percentile(durations(prev), 95),
      spark: hourlyP95(cur),
    },
    errors24h: {
      value: curFailed.length,
      deltaPct: deltaPct(curFailed.length, prevFailed.length),
      spark: hourlyCounts(curFailed),
    },
    cost24h: null,
  };
}

/** Bucket 0 = oldest hour in the window, 23 = most recent (matches the worker). */
function bucketOf(startedAtMin: number): number {
  return Math.max(0, Math.min(23, 23 - Math.floor(startedAtMin / 60)));
}

function durations(rows: RunsResponse["rows"]): number[] {
  return rows
    .map((r) => r.duration)
    .filter((d): d is number => d !== null);
}

function hourlyCounts(rows: RunsResponse["rows"]): number[] {
  const buckets = new Array(24).fill(0);
  for (const r of rows) buckets[bucketOf(r.startedAtMin)] += 1;
  return buckets;
}

function hourlyP95(rows: RunsResponse["rows"]): number[] {
  const perHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const r of rows) {
    if (r.duration !== null) perHour[bucketOf(r.startedAtMin)].push(r.duration);
  }
  return perHour.map((d) => percentile(d, 95));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function deltaPct(cur: number, prev: number): number {
  if (prev === 0) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}
