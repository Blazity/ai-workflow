import { and, count, eq, sql, type SQL } from "drizzle-orm";
import type {
  CostResponse,
  KpisResponse,
  Run,
  RunStatus,
  WorkflowMeta,
  WorkflowRow,
} from "@shared/contracts";
import type { Db } from "../client.js";
import { workflowRuns } from "../schema.js";

/**
 * Postgres read path for the dashboard. Replaces the Vercel Workflow `world.runs`
 * collectors for the recent-runs list, the overview KPIs, the workflows table,
 * and the cost view — sourcing from the durable `workflow_runs` telemetry table
 * instead. Three things this unlocks that the world API could not:
 *   - per-run cost/tokens (persisted by recordRunUsage; the world API has neither)
 *   - real time-window filtering on `started_at` (the world API caps at 100 rows)
 *   - ticket search across all history (indexed `ticket_key` / `ticket_title`)
 *
 * SECURITY: every caller-supplied value reaches SQL only as a *bound parameter*.
 * The window is whitelisted to an enum (parseWindow) → a JS-computed cutoff Date;
 * the search string is bound into an ILIKE pattern with its wildcards escaped
 * (parseSearch + searchCondition). The dashboard sends typed intent, never SQL.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type TimeWindow = (typeof WINDOWS)[number];

const WINDOW_MS: Record<Exclude<TimeWindow, "all">, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

/** Whitelist a raw query value to a known window; anything else → "24h". */
export function parseWindow(raw: unknown): TimeWindow {
  return typeof raw === "string" && (WINDOWS as readonly string[]).includes(raw)
    ? (raw as TimeWindow)
    : "24h";
}

/** Normalize a raw search value: trimmed, length-capped, null when empty. */
export function parseSearch(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 100);
}

function windowBounds(
  window: TimeWindow,
  now: Date,
): { cutoff: Date | null; prevCutoff: Date | null } {
  if (window === "all") return { cutoff: null, prevCutoff: null };
  const ms = WINDOW_MS[window];
  return {
    cutoff: new Date(now.getTime() - ms),
    prevCutoff: new Date(now.getTime() - 2 * ms),
  };
}

/** Effective run time = startedAt, falling back to the always-present firstSeenAt. */
function effTime(): SQL {
  return sql`coalesce(${workflowRuns.startedAt}, ${workflowRuns.firstSeenAt})`;
}

/** `eff >= cutoff` as a bound, typed parameter. */
function effGte(cutoff: Date): SQL {
  return sql`${effTime()} >= ${cutoff.toISOString()}::timestamptz`;
}

/** Escape LIKE/ILIKE wildcards so the search matches the query literally. */
function likeParam(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** `(ticket_key ILIKE $1 OR ticket_title ILIKE $1)` — $1 bound, never interpolated. */
function searchCondition(q: string): SQL {
  const pat = likeParam(q);
  return sql`(${workflowRuns.ticketKey} ilike ${pat} or ${workflowRuns.ticketTitle} ilike ${pat})`;
}

const RUN_STATUSES = new Set<RunStatus>([
  "success",
  "running",
  "failed",
  "blocked",
  "awaiting",
]);

/**
 * `workflow_runs.status` already stores a mapped RunStatus (see
 * collect-snapshots), so it is used as-is. A null status means usage was
 * recorded before the cron snapshot landed — treat it as in-flight.
 */
export function coerceStatus(status: string | null): RunStatus {
  return status && RUN_STATUSES.has(status as RunStatus)
    ? (status as RunStatus)
    : "running";
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
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

// ── Sparkline bucketing ──────────────────────────────────────────────────────
// 24h → 24 hourly buckets; 7d/30d → daily; all → earliest..now split into 30.

interface SparkSpec {
  start: number;
  end: number;
  n: number;
}

function sparkSpec(window: TimeWindow, now: Date, effTimes: number[]): SparkSpec {
  const end = now.getTime();
  if (window === "24h") return { start: end - DAY, end, n: 24 };
  if (window === "7d") return { start: end - 7 * DAY, end, n: 7 };
  if (window === "30d") return { start: end - 30 * DAY, end, n: 30 };
  const earliest = effTimes.length ? Math.min(...effTimes) : end - 30 * DAY;
  return { start: earliest, end, n: 30 };
}

function bucketIndex(t: number, spec: SparkSpec): number {
  if (spec.end <= spec.start) return 0;
  const frac = (t - spec.start) / (spec.end - spec.start);
  return Math.max(0, Math.min(spec.n - 1, Math.floor(frac * spec.n)));
}

function countBuckets(times: number[], spec: SparkSpec): number[] {
  const buckets = new Array(spec.n).fill(0);
  for (const t of times) buckets[bucketIndex(t, spec)] += 1;
  return buckets;
}

function p95Buckets(items: { t: number; dur: number }[], spec: SparkSpec): number[] {
  const per: number[][] = Array.from({ length: spec.n }, () => []);
  for (const it of items) per[bucketIndex(it.t, spec)].push(it.dur);
  return per.map((d) => percentile(d, 95));
}

// Shared run projection + row→Run mapper, used by listRuns and listRunsForTicket.
const runColumns = {
  runId: workflowRuns.runId,
  workflowId: workflowRuns.workflowId,
  workflowName: workflowRuns.workflowName,
  status: workflowRuns.status,
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
} as const;

type RunRow = {
  runId: string;
  workflowId: string | null;
  workflowName: string | null;
  status: string | null;
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
};

function mapRun(r: RunRow, now: Date, tenantOrigin: string, modelFallback: string): Run {
  const eff = r.startedAt ?? r.firstSeenAt;
  const tokens =
    r.tokensInput != null || r.tokensOutput != null
      ? (r.tokensInput ?? 0) + (r.tokensOutput ?? 0)
      : null;
  return {
    id: r.runId,
    workflow: r.workflowId ?? "wf_unknown",
    workflowName: r.workflowName ?? r.workflowId ?? "—",
    status: coerceStatus(r.status),
    ticket: r.ticketKey ?? "",
    actor: "ai-bot",
    model: r.model ?? modelFallback,
    startedAtMin: Math.max(0, Math.round((now.getTime() - eff.getTime()) / 60000)),
    duration: r.durationSec,
    tokens,
    cost: r.costUsd,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: r.ticketTitle ?? r.ticketKey ?? "",
    prNumber: r.prNumber,
    ticketUrl: r.ticketUrl ?? (r.ticketKey ? `${tenantOrigin}/browse/${r.ticketKey}` : ""),
    prUrl: r.prUrl,
  };
}

// ── Recent runs list ─────────────────────────────────────────────────────────

export interface ListRunsOptions {
  db: Db;
  window: TimeWindow;
  q: string | null;
  now: Date;
  jiraBaseUrl: string;
  /** Used when a run has no persisted model (e.g. gate runs). */
  modelFallback: string;
  /** Max rows returned (newest first); counts/total still cover the full match. */
  limit?: number;
}

export interface RunsResult {
  rows: Run[];
  total: number;
  counts: {
    success: number;
    running: number;
    awaiting: number;
    failed: number;
    blocked: number;
  };
}

export async function listRuns(opts: ListRunsOptions): Promise<RunsResult> {
  const { db, window, q, now, jiraBaseUrl, modelFallback } = opts;
  const limit = opts.limit ?? 500;
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");
  const { cutoff } = windowBounds(window, now);

  const conds: SQL[] = [];
  if (cutoff) conds.push(effGte(cutoff));
  if (q) conds.push(searchCondition(q));
  const where = conds.length ? and(...conds) : undefined;

  const data = await db
    .select(runColumns)
    .from(workflowRuns)
    .where(where)
    .orderBy(sql`${effTime()} desc`)
    .limit(limit);

  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  let total = 0;
  const countRows = await db
    .select({ status: workflowRuns.status, n: count() })
    .from(workflowRuns)
    .where(where)
    .groupBy(workflowRuns.status);
  for (const c of countRows) {
    const n = Number(c.n);
    counts[coerceStatus(c.status)] += n;
    total += n;
  }

  const rows = data.map((r) => mapRun(r, now, tenantOrigin, modelFallback));

  return { rows, total, counts };
}

// ── Overview KPIs ────────────────────────────────────────────────────────────

export interface RunKpisOptions {
  db: Db;
  window: TimeWindow;
  now: Date;
}

export async function runKpis(
  opts: RunKpisOptions,
): Promise<Omit<KpisResponse, "generatedAt">> {
  const { db, window, now } = opts;
  const { cutoff, prevCutoff } = windowBounds(window, now);
  const lower = prevCutoff ?? cutoff; // covers both cur and prior windows; null = all

  const rows = await db
    .select({
      startedAt: workflowRuns.startedAt,
      firstSeenAt: workflowRuns.firstSeenAt,
      status: workflowRuns.status,
      durationSec: workflowRuns.durationSec,
      costUsd: workflowRuns.costUsd,
    })
    .from(workflowRuns)
    .where(lower ? effGte(lower) : undefined);

  const cutMs = cutoff ? cutoff.getTime() : -Infinity;
  const prevMs = prevCutoff ? prevCutoff.getTime() : -Infinity;

  const enriched = rows.map((r) => ({
    t: (r.startedAt ?? r.firstSeenAt).getTime(),
    status: r.status,
    dur: r.durationSec,
    cost: r.costUsd ?? 0,
  }));
  const cur = enriched.filter((r) => r.t >= cutMs);
  // "all" has no comparable prior period, so its deltas are reported as 0.
  const hasPrev = cutoff != null && prevCutoff != null;
  const prev = hasPrev
    ? enriched.filter((r) => r.t >= prevMs && r.t < cutMs)
    : [];

  const done = (set: typeof enriched) =>
    set
      .filter((r) => r.status === "success" && r.dur != null)
      .map((r) => ({ t: r.t, dur: r.dur as number }));
  const curDone = done(cur);
  const prevDone = done(prev);
  const curP95 = percentile(curDone.map((d) => d.dur), 95);

  const curFailed = cur.filter((r) => r.status === "failed");
  const prevFailed = prev.filter((r) => r.status === "failed");
  const curCost = sum(cur.map((r) => r.cost));
  const prevCost = sum(prev.map((r) => r.cost));

  const spec = sparkSpec(window, now, cur.map((r) => r.t));

  return {
    runs24h: {
      value: cur.length,
      deltaPct: hasPrev ? deltaPct(cur.length, prev.length) : 0,
      spark: countBuckets(cur.map((r) => r.t), spec),
    },
    p95: {
      valueSec: curP95,
      deltaSec: hasPrev ? curP95 - percentile(prevDone.map((d) => d.dur), 95) : 0,
      spark: p95Buckets(curDone, spec),
    },
    errors24h: {
      value: curFailed.length,
      deltaPct: hasPrev ? deltaPct(curFailed.length, prevFailed.length) : 0,
      spark: countBuckets(curFailed.map((r) => r.t), spec),
    },
    cost24h: {
      value: curCost,
      deltaPct: hasPrev ? deltaPct(curCost, prevCost) : 0,
    },
  };
}

// ── Workflows aggregation ────────────────────────────────────────────────────

export interface WorkflowAggOptions {
  db: Db;
  window: TimeWindow;
  now: Date;
  jiraBaseUrl: string;
  /** Static identity to anchor the rows on (getWorkflowRegistry()). */
  registry: WorkflowMeta[];
}

export interface WorkflowsResult {
  rows: WorkflowRow[];
  total: number;
}

export async function workflowAgg(
  opts: WorkflowAggOptions,
): Promise<WorkflowsResult> {
  const { db, window, now, jiraBaseUrl, registry } = opts;
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");
  const { cutoff } = windowBounds(window, now);

  const winRows = await db
    .select({
      workflowId: workflowRuns.workflowId,
      status: workflowRuns.status,
      durationSec: workflowRuns.durationSec,
      costUsd: workflowRuns.costUsd,
      startedAt: workflowRuns.startedAt,
      firstSeenAt: workflowRuns.firstSeenAt,
    })
    .from(workflowRuns)
    .where(cutoff ? effGte(cutoff) : undefined);

  // Latest run per workflow, regardless of window, so the latest ticket persists.
  const latestRows = await db
    .selectDistinctOn([workflowRuns.workflowId], {
      workflowId: workflowRuns.workflowId,
      ticketKey: workflowRuns.ticketKey,
      ticketTitle: workflowRuns.ticketTitle,
      ticketUrl: workflowRuns.ticketUrl,
      prNumber: workflowRuns.prNumber,
      prUrl: workflowRuns.prUrl,
    })
    .from(workflowRuns)
    .orderBy(workflowRuns.workflowId, sql`${effTime()} desc`);
  const latestById = new Map(latestRows.map((r) => [r.workflowId, r]));

  const rows: WorkflowRow[] = registry.map((w) => {
    const wf = winRows.filter((r) => r.workflowId === w.id);
    const durations = wf
      .map((r) => r.durationSec)
      .filter((d): d is number => d != null);
    const failed = wf.filter((r) => coerceStatus(r.status) === "failed").length;
    const times = wf.map((r) => (r.startedAt ?? r.firstSeenAt).getTime());
    const spec = sparkSpec(window, now, times);
    const lr = latestById.get(w.id);

    return {
      id: w.id,
      name: w.name,
      blurb: w.blurb,
      gateway: w.gateway,
      primary: w.primary,
      runs24h: wf.length,
      p50: durations.length ? percentile(durations, 50) : null,
      p95: durations.length ? percentile(durations, 95) : null,
      errRate: wf.length ? failed / wf.length : null,
      costToday: wf.length ? sum(wf.map((r) => r.costUsd ?? 0)) : null,
      latestRun: lr
        ? {
            ticket: lr.ticketKey ?? "",
            ticketUrl:
              lr.ticketUrl ?? (lr.ticketKey ? `${tenantOrigin}/browse/${lr.ticketKey}` : ""),
            ticketTitle: lr.ticketTitle ?? lr.ticketKey ?? "",
            prNumber: lr.prNumber,
            prUrl: lr.prUrl,
          }
        : null,
      trend24h: wf.length ? countBuckets(times, spec) : null,
    };
  });

  return { rows, total: rows.length };
}

// ── Cost (windowed, from persisted per-run cost) ─────────────────────────────

export interface CostAggOptions {
  db: Db;
  window: TimeWindow;
  now: Date;
}

export async function costAgg(
  opts: CostAggOptions,
): Promise<Omit<CostResponse, "generatedAt" | "available">> {
  const { db, window, now } = opts;
  const { cutoff } = windowBounds(window, now);

  const rows = await db
    .select({
      workflowId: workflowRuns.workflowId,
      workflowName: workflowRuns.workflowName,
      costUsd: workflowRuns.costUsd,
      tokensInput: workflowRuns.tokensInput,
      tokensOutput: workflowRuns.tokensOutput,
      startedAt: workflowRuns.startedAt,
      firstSeenAt: workflowRuns.firstSeenAt,
    })
    .from(workflowRuns)
    .where(cutoff ? effGte(cutoff) : undefined);

  const enriched = rows.map((r) => ({
    workflowId: r.workflowId ?? "wf_unknown",
    workflowName: r.workflowName ?? r.workflowId ?? "—",
    cost: r.costUsd ?? 0,
    tokens: (r.tokensInput ?? 0) + (r.tokensOutput ?? 0),
    t: r.startedAt ?? r.firstSeenAt,
  }));

  const totalTokenCost = sum(enriched.map((r) => r.cost));
  const totalTokens = sum(enriched.map((r) => r.tokens));
  const traceCount = enriched.length;
  const totals = {
    totalTokenCost,
    totalTokens,
    traceCount,
    costPerRun: traceCount ? totalTokenCost / traceCount : 0,
  };

  const byId = new Map<
    string,
    { name: string; runs: number; tokens: number; cost: number }
  >();
  for (const r of enriched) {
    const e = byId.get(r.workflowId) ?? {
      name: r.workflowName,
      runs: 0,
      tokens: 0,
      cost: 0,
    };
    e.runs += 1;
    e.tokens += r.tokens;
    e.cost += r.cost;
    byId.set(r.workflowId, e);
  }
  const byWorkflow = [...byId.entries()]
    .map(([taskId, v]) => ({
      taskId,
      name: v.name,
      runs: v.runs,
      tokens: v.tokens,
      cost: v.cost,
      costPerRun: v.runs ? v.cost / v.runs : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  const byDay = new Map<string, { cost: number; tokens: number }>();
  for (const r of enriched) {
    const date = r.t.toISOString().slice(0, 10);
    const e = byDay.get(date) ?? { cost: 0, tokens: 0 };
    e.cost += r.cost;
    e.tokens += r.tokens;
    byDay.set(date, e);
  }
  const daily = [...byDay.entries()]
    .map(([date, v]) => ({ date, cost: v.cost, tokens: v.tokens }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const start = cutoff
    ? cutoff.toISOString()
    : enriched.length
      ? new Date(Math.min(...enriched.map((r) => r.t.getTime()))).toISOString()
      : now.toISOString();

  return { window: { start, end: now.toISOString() }, totals, byWorkflow, daily };
}

// ── Runs for a single ticket (+ rollup) ──────────────────────────────────────

export interface ListRunsForTicketOptions {
  db: Db;
  ticketKey: string;
  now: Date;
  jiraBaseUrl: string;
  modelFallback: string;
}

export interface TicketRunsResult {
  ticket: { key: string; title: string; url: string } | null;
  runs: Run[];
  totals: {
    cost: number;
    tokens: number;
    runCount: number;
    counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
  };
}

export async function listRunsForTicket(
  opts: ListRunsForTicketOptions,
): Promise<TicketRunsResult> {
  const { db, ticketKey, now, jiraBaseUrl, modelFallback } = opts;
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  const data = await db
    .select(runColumns)
    .from(workflowRuns)
    .where(eq(workflowRuns.ticketKey, ticketKey))
    .orderBy(sql`${effTime()} desc`);

  const runs = data.map((r) => mapRun(r, now, tenantOrigin, modelFallback));

  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  let cost = 0;
  let tokens = 0;
  for (const r of runs) {
    counts[r.status] += 1;
    cost += r.cost ?? 0;
    tokens += r.tokens ?? 0;
  }

  const newest = data[0];
  const ticket = newest
    ? {
        key: newest.ticketKey ?? ticketKey,
        title: newest.ticketTitle ?? newest.ticketKey ?? ticketKey,
        url:
          newest.ticketUrl ??
          `${tenantOrigin}/browse/${newest.ticketKey ?? ticketKey}`,
      }
    : null;

  return { ticket, runs, totals: { cost, tokens, runCount: runs.length, counts } };
}
