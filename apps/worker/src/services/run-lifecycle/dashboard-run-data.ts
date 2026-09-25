import type {
  CostResponse,
  KpisResponse,
  Run,
  RunStatus,
  WorkflowMeta,
  WorkflowRow,
} from "@shared/contracts";
import type { Db } from "../../db/types.js";
import { runKpiCutoff, runKpisFromRows } from "../../engine/overview-aggregates.js";
import { ticketLinkFor, type TicketLinks } from "../../engine/support/ticket-url.js";
import {
  connectedDashboardRunQueries,
  countDashboardRunRowsByStatus,
  listCostAggregateRows,
  listDashboardRunRows,
  listLatestWorkflowRunRows,
  listRunKpiRows,
  listTicketRunRows,
  listWorkflowAggregateRows,
  type DashboardRunRow,
} from "../../db/repositories/runs/dashboard-query-rows.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOWS = ["24h", "7d", "30d", "all"] as const;
const RUN_STATUSES = new Set<RunStatus>(["success", "running", "failed", "blocked", "awaiting"]);
export type TimeWindow = (typeof WINDOWS)[number];
const WINDOW_MS: Record<Exclude<TimeWindow, "all">, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

export function parseWindow(raw: unknown): TimeWindow {
  return typeof raw === "string" && (WINDOWS as readonly string[]).includes(raw)
    ? raw as TimeWindow
    : "24h";
}

export function parseSearch(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 100) : null;
}

export function coerceStatus(status: string | null): RunStatus {
  return status && RUN_STATUSES.has(status as RunStatus) ? status as RunStatus : "running";
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function bounds(window: TimeWindow, now: Date) {
  if (window === "all") return { cutoff: null, prevCutoff: null };
  const duration = WINDOW_MS[window];
  return {
    cutoff: new Date(now.getTime() - duration),
    prevCutoff: new Date(now.getTime() - 2 * duration),
  };
}

function mapRun(row: DashboardRunRow, now: Date, links: TicketLinks): Run {
  const effective = row.startedAt ?? row.firstSeenAt;
  const tokens = row.tokensInput !== null || row.tokensOutput !== null
    ? (row.tokensInput ?? 0) + (row.tokensOutput ?? 0)
    : null;
  return {
    id: row.runId,
    workflow: row.workflowId ?? "wf_unknown",
    workflowName: row.workflowName ?? row.workflowId ?? "-",
    status: coerceStatus(row.status),
    statusReason: row.statusReason,
    ticket: row.ticketKey ?? "",
    actor: "ai-bot",
    model: row.model,
    startedAtMin: Math.max(0, Math.round((now.getTime() - effective.getTime()) / 60_000)),
    duration: row.durationSec,
    tokens,
    cost: row.costUsd,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: row.ticketTitle ?? row.ticketKey ?? "",
    prNumber: row.prNumber,
    ticketUrl: ticketLinkFor(row.ticketUrl, row.ticketKey, links) ?? "",
    prUrl: row.prUrl,
    prs: row.prs,
  };
}

type Queries = typeof connectedDashboardRunQueries;
function explicitQueries(db: Db): Queries {
  return {
    listRuns: (input) => listDashboardRunRows(db, input),
    countRuns: (input) => countDashboardRunRowsByStatus(db, input),
    listKpis: (cutoff) => listRunKpiRows(db, cutoff),
    listWorkflowRows: (cutoff) => listWorkflowAggregateRows(db, cutoff),
    listLatestWorkflowRows: () => listLatestWorkflowRunRows(db),
    listCosts: (cutoff) => listCostAggregateRows(db, cutoff),
    listTicketRuns: (ticketKey) => listTicketRunRows(db, ticketKey),
  };
}

export interface ListRunsOptions {
  window: TimeWindow;
  q: string | null;
  now: Date;
  /** How the active tracker links a ticket (`issueTrackerTicketLinks`). */
  ticketLinks: TicketLinks;
  limit?: number;
}

export async function listRuns(options: ListRunsOptions & { db: Db }) {
  return listRunsWithQueries(explicitQueries(options.db), options);
}

export function connectedListRuns(options: ListRunsOptions) {
  return listRunsWithQueries(connectedDashboardRunQueries, options);
}

async function listRunsWithQueries(queries: Queries, options: ListRunsOptions) {
  const cutoff = bounds(options.window, options.now).cutoff;
  const [data, countRows] = await Promise.all([
    queries.listRuns({ cutoff, q: options.q, limit: options.limit ?? 500 }),
    queries.countRuns({ cutoff, q: options.q }),
  ]);
  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  let total = 0;
  for (const row of countRows) {
    const count = Number(row.n);
    counts[coerceStatus(row.status)] += count;
    total += count;
  }
  return {
    rows: data.map((row) => mapRun(row, options.now, options.ticketLinks)),
    total,
    counts,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

type SparkSpec = { start: number; end: number; n: number };
function sparkSpec(window: TimeWindow, now: Date, times: number[]): SparkSpec {
  const end = now.getTime();
  if (window === "24h") return { start: end - DAY, end, n: 24 };
  if (window === "7d") return { start: end - 7 * DAY, end, n: 7 };
  if (window === "30d") return { start: end - 30 * DAY, end, n: 30 };
  return { start: times.length > 0 ? Math.min(...times) : end - 30 * DAY, end, n: 30 };
}

function bucketIndex(time: number, spec: SparkSpec): number {
  if (spec.end <= spec.start) return 0;
  const fraction = (time - spec.start) / (spec.end - spec.start);
  return Math.max(0, Math.min(spec.n - 1, Math.floor(fraction * spec.n)));
}

function countBuckets(times: number[], spec: SparkSpec): number[] {
  const buckets = Array.from({ length: spec.n }, () => 0);
  for (const time of times) buckets[bucketIndex(time, spec)] += 1;
  return buckets;
}

export async function runKpis(
  options: { db: Db; window: TimeWindow; now: Date },
): Promise<Omit<KpisResponse, "generatedAt">> {
  return runKpisWithQueries(explicitQueries(options.db), options);
}

export function connectedRunKpis(options: { window: TimeWindow; now: Date }) {
  return runKpisWithQueries(connectedDashboardRunQueries, options);
}

async function runKpisWithQueries(
  queries: Queries,
  options: { window: TimeWindow; now: Date },
): Promise<Omit<KpisResponse, "generatedAt">> {
  const rows = await queries.listKpis(runKpiCutoff(options.window, options.now));
  return runKpisFromRows(rows, options.window, options.now);
}

/** The gateway a harness reaches its models through. */
const HARNESS_GATEWAYS: Readonly<Record<string, string>> = {
  claude: "anthropic",
  codex: "openai",
};

/**
 * The gateways a workflow's runs in the window were launched on, from the
 * harness manifests they recorded ("anthropic + openai" when both), or empty
 * when no run says. A workflow row covers every stored definition and each of
 * those picks its own harness per block, so no single configured default
 * describes it: naming the built-in default showed "openai" beside runs that
 * executed on Claude.
 */
function observedGateway(providersPerRun: readonly unknown[]): string {
  const gateways = new Set<string>();
  for (const providers of providersPerRun) {
    if (!Array.isArray(providers)) continue;
    for (const provider of providers) {
      const gateway = typeof provider === "string" ? HARNESS_GATEWAYS[provider] : undefined;
      if (gateway) gateways.add(gateway);
    }
  }
  return [...gateways].sort().join(" + ");
}

export interface WorkflowAggOptions {
  window: TimeWindow;
  now: Date;
  ticketLinks: TicketLinks;
  registry: WorkflowMeta[];
}

export async function workflowAgg(options: WorkflowAggOptions & { db: Db }) {
  return workflowAggWithQueries(explicitQueries(options.db), options);
}

export function connectedWorkflowAgg(options: WorkflowAggOptions) {
  return workflowAggWithQueries(connectedDashboardRunQueries, options);
}

async function workflowAggWithQueries(queries: Queries, options: WorkflowAggOptions) {
  const cutoff = bounds(options.window, options.now).cutoff;
  const [windowRows, latestRows] = await Promise.all([
    queries.listWorkflowRows(cutoff),
    queries.listLatestWorkflowRows(),
  ]);
  const latestById = new Map(latestRows.map((row) => [row.workflowId, row]));
  const rows: WorkflowRow[] = options.registry.map((workflow) => {
    const selected = windowRows.filter((row) => row.workflowId === workflow.id);
    const gateway = observedGateway(selected.map((row) => row.harnessProviders));
    const durations = selected.map((row) => row.durationSec).filter((value): value is number => value !== null);
    const failed = selected.filter((row) => coerceStatus(row.status) === "failed").length;
    const times = selected.map((row) => (row.startedAt ?? row.firstSeenAt).getTime());
    const latest = latestById.get(workflow.id);
    return {
      ...workflow,
      gateway,
      runs24h: selected.length,
      p50: durations.length > 0 ? percentile(durations, 50) : null,
      p95: durations.length > 0 ? percentile(durations, 95) : null,
      errRate: selected.length > 0 ? failed / selected.length : null,
      costToday: selected.length > 0 ? sum(selected.map((row) => row.costUsd ?? 0)) : null,
      latestRun: latest ? {
        ticket: latest.ticketKey ?? "",
        ticketUrl: ticketLinkFor(latest.ticketUrl, latest.ticketKey, options.ticketLinks) ?? "",
        ticketTitle: latest.ticketTitle ?? latest.ticketKey ?? "",
        prNumber: latest.prNumber,
        prUrl: latest.prUrl,
        prs: latest.prs,
      } : null,
      trend24h: selected.length > 0 ? countBuckets(times, sparkSpec(options.window, options.now, times)) : null,
    };
  });
  return { rows, total: rows.length };
}

export async function costAgg(
  options: { db: Db; window: TimeWindow; now: Date },
): Promise<Omit<CostResponse, "generatedAt" | "available">> {
  return costAggWithQueries(explicitQueries(options.db), options);
}

export function connectedCostAgg(options: { window: TimeWindow; now: Date }) {
  return costAggWithQueries(connectedDashboardRunQueries, options);
}

async function costAggWithQueries(
  queries: Queries,
  options: { window: TimeWindow; now: Date },
): Promise<Omit<CostResponse, "generatedAt" | "available">> {
  const cutoff = bounds(options.window, options.now).cutoff;
  const rows = await queries.listCosts(cutoff);
  const enriched = rows.map((row) => ({
    // A run that names a stored definition is grouped by that definition, so
    // every ticket workflow gets its own bucket instead of collapsing into
    // the one Workflow DevKit function ("wf_agent") every definition runs
    // through. A run with no definition (pre-sandbox, the post-PR gate) has
    // no other identity to group by, so it keeps the raw workflow id.
    groupKey: row.definitionId != null ? `def_${row.definitionId}` : (row.workflowId ?? "wf_unknown"),
    workflowName: row.workflowName ?? row.workflowId ?? "-",
    cost: row.costUsd ?? 0,
    tokens: (row.tokensInput ?? 0) + (row.tokensOutput ?? 0),
    time: row.startedAt ?? row.firstSeenAt,
  }));
  const totalTokenCost = sum(enriched.map((row) => row.cost));
  const totalTokens = sum(enriched.map((row) => row.tokens));
  const traceCount = enriched.length;
  const byId = new Map<string, { name: string; runs: number; tokens: number; cost: number }>();
  for (const row of enriched) {
    const value = byId.get(row.groupKey) ?? { name: row.workflowName, runs: 0, tokens: 0, cost: 0 };
    value.runs += 1;
    value.tokens += row.tokens;
    value.cost += row.cost;
    byId.set(row.groupKey, value);
  }
  const byWorkflow = [...byId.entries()].map(([taskId, value]) => ({
    taskId,
    name: value.name,
    runs: value.runs,
    tokens: value.tokens,
    cost: value.cost,
    costPerRun: value.runs ? value.cost / value.runs : 0,
  })).sort((left, right) => right.cost - left.cost);
  const byDay = new Map<string, { cost: number; tokens: number }>();
  for (const row of enriched) {
    const date = row.time.toISOString().slice(0, 10);
    const value = byDay.get(date) ?? { cost: 0, tokens: 0 };
    value.cost += row.cost;
    value.tokens += row.tokens;
    byDay.set(date, value);
  }
  const daily = [...byDay.entries()].map(([date, value]) => ({
    date,
    cost: value.cost,
    tokens: value.tokens,
  }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const start = cutoff
    ? cutoff.toISOString()
    : enriched.length > 0
      ? new Date(Math.min(...enriched.map((row) => row.time.getTime()))).toISOString()
      : options.now.toISOString();
  return {
    window: { start, end: options.now.toISOString() },
    totals: { totalTokenCost, totalTokens, traceCount, costPerRun: traceCount ? totalTokenCost / traceCount : 0 },
    byWorkflow,
    daily,
  };
}

export async function listRunsForTicket(
  options: { db: Db; ticketKey: string; now: Date; ticketLinks: TicketLinks },
) {
  return listRunsForTicketWithQueries(explicitQueries(options.db), options);
}

export function connectedListRunsForTicket(options: { ticketKey: string; now: Date; ticketLinks: TicketLinks }) {
  return listRunsForTicketWithQueries(connectedDashboardRunQueries, options);
}

async function listRunsForTicketWithQueries(
  queries: Queries,
  options: { ticketKey: string; now: Date; ticketLinks: TicketLinks },
) {
  const data = await queries.listTicketRuns(options.ticketKey);
  const runs = data.map((row) => mapRun(row, options.now, options.ticketLinks));
  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  let cost = 0;
  let tokens = 0;
  for (const run of runs) {
    counts[run.status] += 1;
    cost += run.cost ?? 0;
    tokens += run.tokens ?? 0;
  }
  const newest = data[0];
  const ticket = newest ? {
    key: newest.ticketKey ?? options.ticketKey,
    title: newest.ticketTitle ?? newest.ticketKey ?? options.ticketKey,
    url:
      ticketLinkFor(newest.ticketUrl, newest.ticketKey ?? options.ticketKey, options.ticketLinks) ??
      "",
  } : null;
  return { ticket, runs, totals: { cost, tokens, runCount: runs.length, counts } };
}
