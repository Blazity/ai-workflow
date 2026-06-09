import type { EvalsResponse } from "@shared/contracts";
import type { ArthurTask } from "../../sandbox/arthur-client.js";

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
  listAllTasks(): Promise<ArthurTask[]>;
  countTraces(
    taskIds: string[],
    startTime: string,
    endTime: string,
    filters?: Record<string, string>,
  ): Promise<number>;
}

export interface CollectEvalsOptions {
  client: EvalsArthurClient;
  windowHours: number;
  now: Date;
}

/**
 * Aggregates Arthur's per-trace eval outcomes into fleet-wide eval health.
 * Arthur has no eval-overview endpoint, so we count traces by their
 * `continuous_eval_run_status` over every task in the window:
 *   - `spansGraded` = graded traces = passed + failed
 *   - `score`       = pass rate = passed / graded × 100
 *   - `traceCount`  = total traces in the window (graded or not)
 * When `spansGraded` is 0 (no continuous evals configured / nothing graded),
 * `score` is 0 and the route turns that into `available: false`.
 */
export async function collectEvals(
  opts: CollectEvalsOptions,
): Promise<EvalsAggregate> {
  const endTime = opts.now.toISOString();
  const startTime = new Date(
    opts.now.getTime() - opts.windowHours * HOUR,
  ).toISOString();

  const ids = (await opts.client.listAllTasks()).map((t) => t.id);

  const [passed, failed, traceCount] = await Promise.all([
    opts.client.countTraces(ids, startTime, endTime, {
      continuous_eval_run_status: "passed",
    }),
    opts.client.countTraces(ids, startTime, endTime, {
      continuous_eval_run_status: "failed",
    }),
    opts.client.countTraces(ids, startTime, endTime),
  ]);

  const graded = passed + failed;
  const score = graded > 0 ? (passed / graded) * 100 : 0;

  return {
    windowHours: opts.windowHours,
    score,
    spansGraded: graded,
    traceCount,
  };
}
