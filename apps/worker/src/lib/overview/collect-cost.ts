import type { CostResponse } from "@shared/contracts";
import type { ArthurTask, TraceRow } from "../../sandbox/arthur-client.js";

/**
 * The slice of `ArthurClient` the cost collector depends on. The real object is
 * an `ArthurClient`; this narrow interface keeps the aggregation testable with a
 * fake (mirrors `RunsLister` for the run-store collectors).
 */
export interface CostArthurClient {
  listAllTasks(): Promise<ArthurTask[]>;
  listTraces(taskIds: string[], startTime: string, endTime: string): Promise<TraceRow[]>;
}

export interface CollectCostOptions {
  now: Date;
}

/**
 * Shapes a `CostResponse` (minus `generatedAt`/`available`) from Arthur trace
 * rows. Arthur has no pre-aggregated overview endpoint, so we enumerate tasks,
 * pull their traces for the calendar month-to-date window, and aggregate
 * client-side. Cost comes straight from Arthur's `total_token_cost` field (null
 * → 0) — no client-side pricing.
 *
 * - `totals` sum across every trace row.
 * - `byWorkflow` groups rows by `task_id` (Arthur tasks ARE the workflow
 *   grouping, one per ticket-run); only tasks that have traces are included.
 * - `daily` buckets rows by their `start_time` calendar day (YYYY-MM-DD).
 */
export async function collectCost(
  client: CostArthurClient,
  opts: CollectCostOptions,
): Promise<Omit<CostResponse, "generatedAt" | "available">> {
  const { now } = opts;
  // Calendar month-to-date (matches the "MTD" framing).
  const start = startOfMonthUTC(now).toISOString();
  const end = now.toISOString();

  const tasks = await client.listAllTasks();
  const names = new Map(tasks.map((t) => [t.id, t.name]));
  const ids = tasks.map((t) => t.id);

  const traces = await client.listTraces(ids, start, end);

  let totalTokenCost = 0;
  let totalTokens = 0;
  for (const t of traces) {
    totalTokenCost += t.total_token_cost ?? 0;
    totalTokens += t.total_token_count;
  }
  const traceCount = traces.length;
  const totals = {
    totalTokenCost,
    totalTokens,
    traceCount,
    costPerRun: traceCount > 0 ? totalTokenCost / traceCount : 0,
  };

  // Group by task_id — only tasks that actually have traces appear.
  const byTask = new Map<string, { runs: number; tokens: number; cost: number }>();
  for (const t of traces) {
    const row = byTask.get(t.task_id) ?? { runs: 0, tokens: 0, cost: 0 };
    row.runs += 1;
    row.tokens += t.total_token_count;
    row.cost += t.total_token_cost ?? 0;
    byTask.set(t.task_id, row);
  }
  const byWorkflow = [...byTask.entries()].map(([taskId, v]) => ({
    taskId,
    name: names.get(taskId) ?? taskId,
    runs: v.runs,
    tokens: v.tokens,
    cost: v.cost,
    costPerRun: v.runs > 0 ? v.cost / v.runs : 0,
  }));

  // Bucket by calendar day, oldest -> newest.
  const byDay = new Map<string, { cost: number; tokens: number }>();
  for (const t of traces) {
    const date = t.start_time.slice(0, 10);
    const row = byDay.get(date) ?? { cost: 0, tokens: 0 };
    row.cost += t.total_token_cost ?? 0;
    row.tokens += t.total_token_count;
    byDay.set(date, row);
  }
  const daily = [...byDay.entries()]
    .map(([date, v]) => ({ date, cost: v.cost, tokens: v.tokens }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { window: { start, end }, totals, byWorkflow, daily };
}

function startOfMonthUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
