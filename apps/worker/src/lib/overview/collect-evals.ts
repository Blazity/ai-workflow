import type { EvalsResponse } from "@shared/contracts";
import type { TraceOverview } from "../../sandbox/arthur-client.js";

const HOUR = 3_600_000;

/** Fleet aggregate fields the route spreads onto an `available: true` response. */
export type EvalsAggregate = Pick<
  Extract<EvalsResponse, { available: true }>,
  "windowHours" | "score" | "spansGraded" | "traceCount"
>;

/**
 * The slice of `ArthurClient` the eval collector depends on. The real object is
 * an `ArthurClient`; this narrow interface keeps the aggregation testable with a
 * fake (mirrors `CostArthurClient` for the cost collector).
 */
export interface EvalsArthurClient {
  getTracesOverview(
    taskIds: string[],
    startTime: string,
    endTime: string,
  ): Promise<{ overviews: TraceOverview[] }>;
}

export interface CollectEvalsOptions {
  client: EvalsArthurClient;
  // TODO(arthur-verify): unconfirmed whether `taskIds: []` means "all org tasks"
  // on POST /api/v1/traces/overview. If not, the route must enumerate tasks first.
  taskIds: string[];
  windowHours: number;
  now: Date;
}

/**
 * Aggregates Arthur's per-task trace overviews into fleet-wide eval health:
 * eval-count-weighted success rate × 100, summed spans-graded and trace counts
 * over the window. When `spansGraded` sums to 0 (no continuous evals configured
 * / nothing graded), `score` is 0 and the route turns that into
 * `available: false`.
 */
export async function collectEvals(
  opts: CollectEvalsOptions,
): Promise<EvalsAggregate> {
  const endTime = opts.now.toISOString();
  const startTime = new Date(
    opts.now.getTime() - opts.windowHours * HOUR,
  ).toISOString();

  const { overviews } = await opts.client.getTracesOverview(
    opts.taskIds,
    startTime,
    endTime,
  );

  const spansGraded = sum(overviews, (o) => o.eval_count);
  const traceCount = sum(overviews, (o) => o.trace_count);
  const score =
    spansGraded === 0
      ? 0
      : (sum(overviews, (o) => o.continuous_eval_success_rate * o.eval_count) /
          spansGraded) *
        100;

  return {
    windowHours: opts.windowHours,
    score,
    spansGraded,
    traceCount,
  };
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + (pick(item) || 0), 0);
}
