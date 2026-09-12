import type { CostResponse, KpisResponse } from "@shared/contracts";
import { connectedDashboardRunQueries } from "../db/repositories/runs/dashboard-query-rows.js";

const DAY = 86_400_000;
const WINDOWS = ["24h", "7d", "30d", "all"] as const;
type TimeWindow = (typeof WINDOWS)[number];
const WINDOW_MS: Record<Exclude<TimeWindow, "all">, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

function parseWindow(raw: unknown): TimeWindow {
  return typeof raw === "string" && (WINDOWS as readonly string[]).includes(raw)
    ? raw as TimeWindow
    : "24h";
}

function bounds(window: TimeWindow, now: Date) {
  if (window === "all") return { cutoff: null, previousCutoff: null };
  const duration = WINDOW_MS[window];
  return {
    cutoff: new Date(now.getTime() - duration),
    previousCutoff: new Date(now.getTime() - 2 * duration),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function deltaPct(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

interface SparkSpec { start: number; end: number; count: number }

function sparkSpec(window: TimeWindow, now: Date, times: number[]): SparkSpec {
  const end = now.getTime();
  if (window === "24h") return { start: end - DAY, end, count: 24 };
  if (window === "7d") return { start: end - 7 * DAY, end, count: 7 };
  if (window === "30d") return { start: end - 30 * DAY, end, count: 30 };
  return { start: times.length > 0 ? Math.min(...times) : end - 30 * DAY, end, count: 30 };
}

function bucketIndex(time: number, spec: SparkSpec): number {
  if (spec.end <= spec.start) return 0;
  const fraction = (time - spec.start) / (spec.end - spec.start);
  return Math.max(0, Math.min(spec.count - 1, Math.floor(fraction * spec.count)));
}

function countBuckets(times: number[], spec: SparkSpec): number[] {
  const buckets = Array.from({ length: spec.count }, () => 0);
  for (const time of times) buckets[bucketIndex(time, spec)] += 1;
  return buckets;
}

function p95Buckets(items: Array<{ time: number; duration: number }>, spec: SparkSpec): number[] {
  const buckets: number[][] = Array.from({ length: spec.count }, () => []);
  for (const item of items) buckets[bucketIndex(item.time, spec)].push(item.duration);
  return buckets.map((values) => percentile(values, 95));
}

export async function collectConnectedRunKpis(
  windowParam: unknown,
  now: Date,
): Promise<Omit<KpisResponse, "generatedAt">> {
  const window = parseWindow(windowParam);
  const { cutoff, previousCutoff } = bounds(window, now);
  const rows = await connectedDashboardRunQueries.listKpis(previousCutoff ?? cutoff);
  const cutoffMs = cutoff?.getTime() ?? -Infinity;
  const previousMs = previousCutoff?.getTime() ?? -Infinity;
  const enriched = rows.map((row) => ({
    time: (row.startedAt ?? row.firstSeenAt).getTime(),
    status: row.status,
    duration: row.durationSec,
    cost: row.costUsd ?? 0,
  }));
  const current = enriched.filter((row) => row.time >= cutoffMs);
  const hasPrevious = cutoff !== null && previousCutoff !== null;
  const previous = hasPrevious
    ? enriched.filter((row) => row.time >= previousMs && row.time < cutoffMs)
    : [];
  const completed = (values: typeof enriched) => values
    .filter((row) => row.status === "success" && row.duration !== null)
    .map((row) => ({ time: row.time, duration: row.duration as number }));
  const currentDone = completed(current);
  const previousDone = completed(previous);
  const currentFailed = current.filter((row) => row.status === "failed");
  const previousFailed = previous.filter((row) => row.status === "failed");
  const currentCost = sum(current.map((row) => row.cost));
  const previousCost = sum(previous.map((row) => row.cost));
  const currentP95 = percentile(currentDone.map((row) => row.duration), 95);
  const spec = sparkSpec(window, now, current.map((row) => row.time));
  return {
    runs24h: { value: current.length, deltaPct: hasPrevious ? deltaPct(current.length, previous.length) : 0, spark: countBuckets(current.map((row) => row.time), spec) },
    p95: { valueSec: currentP95, deltaSec: hasPrevious ? currentP95 - percentile(previousDone.map((row) => row.duration), 95) : 0, spark: p95Buckets(currentDone, spec) },
    errors24h: { value: currentFailed.length, deltaPct: hasPrevious ? deltaPct(currentFailed.length, previousFailed.length) : 0, spark: countBuckets(currentFailed.map((row) => row.time), spec) },
    cost24h: { value: currentCost, deltaPct: hasPrevious ? deltaPct(currentCost, previousCost) : 0 },
  };
}

export async function collectConnectedCostAggregate(
  windowParam: unknown,
  now: Date,
): Promise<Omit<CostResponse, "generatedAt" | "available">> {
  const { cutoff } = bounds(parseWindow(windowParam), now);
  const rows = await connectedDashboardRunQueries.listCosts(cutoff);
  const enriched = rows.map((row) => ({
    workflowId: row.workflowId ?? "wf_unknown",
    workflowName: row.workflowName ?? row.workflowId ?? "-",
    cost: row.costUsd ?? 0,
    tokens: (row.tokensInput ?? 0) + (row.tokensOutput ?? 0),
    time: row.startedAt ?? row.firstSeenAt,
  }));
  const byId = new Map<string, { name: string; runs: number; tokens: number; cost: number }>();
  const byDay = new Map<string, { cost: number; tokens: number }>();
  for (const row of enriched) {
    const workflow = byId.get(row.workflowId) ?? { name: row.workflowName, runs: 0, tokens: 0, cost: 0 };
    workflow.runs += 1;
    workflow.tokens += row.tokens;
    workflow.cost += row.cost;
    byId.set(row.workflowId, workflow);
    const day = row.time.toISOString().slice(0, 10);
    const daily = byDay.get(day) ?? { cost: 0, tokens: 0 };
    daily.cost += row.cost;
    daily.tokens += row.tokens;
    byDay.set(day, daily);
  }
  const totalTokenCost = sum(enriched.map((row) => row.cost));
  const totalTokens = sum(enriched.map((row) => row.tokens));
  const traceCount = enriched.length;
  const start = cutoff
    ? cutoff.toISOString()
    : enriched.length > 0
      ? new Date(Math.min(...enriched.map((row) => row.time.getTime()))).toISOString()
      : now.toISOString();
  return {
    window: { start, end: now.toISOString() },
    totals: {
      totalTokenCost,
      totalTokens,
      traceCount,
      costPerRun: traceCount > 0 ? totalTokenCost / traceCount : 0,
    },
    byWorkflow: [...byId.entries()].map(([taskId, value]) => ({
      taskId,
      name: value.name,
      runs: value.runs,
      tokens: value.tokens,
      cost: value.cost,
      costPerRun: value.runs > 0 ? value.cost / value.runs : 0,
    })).sort((left, right) => right.cost - left.cost),
    daily: [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, value]) => Object.assign({ date }, value)),
  };
}
