import type { CostResponse } from "@shared/contracts";
import { logger } from "../logger.js";
import type {
  TraceOverviewListResponse,
  TraceTimeseriesPoint,
  ModelTokenCost,
} from "../../sandbox/arthur-client.js";

/**
 * The slice of `ArthurClient` the cost collector depends on. The real object is
 * an `ArthurClient`; this narrow interface keeps the aggregation testable with a
 * fake (mirrors `RunsLister` for the run-store collectors).
 */
export interface CostArthurClient {
  getTracesOverview(
    taskIds: string[],
    startTime: string,
    endTime: string,
  ): Promise<TraceOverviewListResponse>;
  getTracesTimeseries(
    taskId: string,
    startTime: string,
    endTime: string,
    bucketSize: string,
  ): Promise<TraceTimeseriesPoint[]>;
  aggregateSpanTokensByModel(
    taskIds: string[],
    startTime: string,
    endTime: string,
  ): Promise<ModelTokenCost[]>;
}

export interface CollectCostOptions {
  now: Date;
  /** Bucket granularity for the daily-spend timeseries. */
  bucketSize: string;
}

/**
 * Shapes a `CostResponse` (minus `generatedAt`/`available`) from Arthur's
 * pre-aggregated token/cost data. Cost comes straight from Arthur's
 * `*_token_cost` fields — no client-side pricing.
 *
 * - `totals` + `byWorkflow` come from one `getTracesOverview` call. Arthur tasks
 *   ARE the workflow grouping (per ticket-run), so each overview row is one
 *   `byWorkflow` entry.
 * - `byModel` comes from `aggregateSpanTokensByModel` (the one client-side
 *   grouping, since Arthur has no per-model overview).
 * - `daily` fans out one `getTracesTimeseries` call per task that appears in the
 *   overview and merges points by bucket timestamp.
 */
export async function collectCost(
  client: CostArthurClient,
  opts: CollectCostOptions,
): Promise<Omit<CostResponse, "generatedAt" | "available">> {
  const { now, bucketSize } = opts;
  // Assumption: calendar month-to-date (matches the original "MTD" framing).
  // TODO(arthur-verify): confirm the intended window (calendar MTD vs rolling 30d/24h).
  const start = startOfMonthUTC(now).toISOString();
  const end = now.toISOString();

  // TODO(arthur-verify): empty `task_ids` is assumed to mean org-wide. If Arthur
  // requires explicit ids, enumerate the org's tasks and pass them instead.
  const { overviews } = await client.getTracesOverview([], start, end);

  let totalTokenCost = 0;
  let totalTokens = 0;
  let traceCount = 0;
  const byWorkflow = overviews.map((o) => {
    // trace_token_cost is null when Arthur has no cost data — treat as 0.
    const cost = o.trace_token_cost ?? 0;
    totalTokenCost += cost;
    totalTokens += o.trace_token_count;
    traceCount += o.trace_count;
    return {
      taskId: o.task_id,
      // Arthur task name = the ticket-run identifier; overview omits it, so the
      // task_id (which IS that identifier) doubles as the display name.
      // TODO(arthur-verify): task->workflow mapping — rows stay per-task.
      name: o.task_id,
      runs: o.trace_count,
      tokens: o.trace_token_count,
      cost,
      costPerRun: o.trace_count > 0 ? cost / o.trace_count : 0,
    };
  });

  const totals = {
    totalTokenCost,
    totalTokens,
    traceCount,
    costPerRun: traceCount > 0 ? totalTokenCost / traceCount : 0,
  };

  const byModelRaw = await client.aggregateSpanTokensByModel([], start, end);
  const byModel = byModelRaw.map((m) => ({
    model: m.model,
    cost: m.cost,
    tokens: m.tokens,
  }));

  // Fan out one timeseries call per task that has data, then merge by bucket.
  // Tasks are per-ticket-run, so a busy month can be hundreds — cap the fan-out
  // to the most-active tasks to avoid an unbounded burst of requests.
  // TODO(arthur-verify): cap is by trace_count, on the assumption the highest-
  // traffic tasks dominate the daily-spend curve; revisit if the chart looks short.
  const DAILY_FANOUT_CAP = 50;
  const sortedByActivity = [...overviews].sort((a, b) => b.trace_count - a.trace_count);
  const fanoutTasks = sortedByActivity.slice(0, DAILY_FANOUT_CAP);
  if (sortedByActivity.length > DAILY_FANOUT_CAP) {
    logger.info(
      {
        total: sortedByActivity.length,
        capped: DAILY_FANOUT_CAP,
        dropped: sortedByActivity.slice(DAILY_FANOUT_CAP).map((o) => o.task_id),
      },
      "cost_daily_fanout_capped",
    );
  }
  const taskIds = fanoutTasks.map((o) => o.task_id);
  const series = await Promise.all(
    taskIds.map((id) => client.getTracesTimeseries(id, start, end, bucketSize)),
  );
  const merged = new Map<string, { cost: number; tokens: number }>();
  for (const points of series) {
    for (const p of points) {
      const row = merged.get(p.timestamp) ?? { cost: 0, tokens: 0 };
      row.cost += p.trace_token_cost ?? 0;
      row.tokens += p.trace_token_count;
      merged.set(p.timestamp, row);
    }
  }
  const daily = [...merged.entries()]
    .map(([date, v]) => ({ date, cost: v.cost, tokens: v.tokens }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { window: { start, end }, totals, byModel, byWorkflow, daily };
}

function startOfMonthUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
