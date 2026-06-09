import { describe, it, expect, vi } from "vitest";
import { collectCost, type CostArthurClient } from "./collect-cost.js";
import type {
  TraceOverviewListResponse,
  TraceTimeseriesPoint,
  ModelTokenCost,
} from "../../sandbox/arthur-client.js";

const NOW = new Date("2026-06-08T12:00:00.000Z");

function makeClient(opts: {
  overview: TraceOverviewListResponse;
  timeseries: Record<string, TraceTimeseriesPoint[]>;
  byModel: ModelTokenCost[];
}): CostArthurClient {
  return {
    getTracesOverview: vi.fn().mockResolvedValue(opts.overview),
    getTracesTimeseries: vi
      .fn()
      .mockImplementation((taskId: string) =>
        Promise.resolve(opts.timeseries[taskId] ?? []),
      ),
    aggregateSpanTokensByModel: vi.fn().mockResolvedValue(opts.byModel),
  };
}

describe("collectCost", () => {
  it("aggregates totals, per-task breakdown, by-model, and merged daily series", async () => {
    const client = makeClient({
      overview: {
        count: 2,
        overviews: [
          {
            task_id: "t1",
            trace_count: 4,
            trace_token_count: 1000,
            trace_token_cost: 2.0,
            eval_count: 0,
            continuous_eval_success_rate: 1,
            last_active: "2026-06-08",
          },
          {
            task_id: "t2",
            trace_count: 6,
            trace_token_count: 3000,
            trace_token_cost: 4.0,
            eval_count: 0,
            continuous_eval_success_rate: 1,
          },
        ],
      },
      timeseries: {
        t1: [
          { timestamp: "2026-06-06", trace_count: 2, trace_token_count: 500, trace_token_cost: 1.0 },
          { timestamp: "2026-06-07", trace_count: 2, trace_token_count: 500, trace_token_cost: 1.0 },
        ],
        t2: [
          { timestamp: "2026-06-07", trace_count: 3, trace_token_count: 1500, trace_token_cost: 2.0 },
          { timestamp: "2026-06-08", trace_count: 3, trace_token_count: 1500, trace_token_cost: 2.0 },
        ],
      },
      byModel: [
        { model: "claude-opus-4-6", tokens: 3000, cost: 5.0 },
        { model: "claude-haiku", tokens: 1000, cost: 1.0 },
      ],
    });

    const data = await collectCost(client, { now: NOW, bucketSize: "day" });

    // totals
    expect(data.totals).toEqual({
      totalTokenCost: 6.0,
      totalTokens: 4000,
      traceCount: 10,
      costPerRun: 0.6,
    });

    // window = calendar MTD
    expect(data.window.start).toBe("2026-06-01T00:00:00.000Z");
    expect(data.window.end).toBe(NOW.toISOString());

    // byWorkflow = per-task, with costPerRun guarded
    expect(data.byWorkflow).toEqual([
      { taskId: "t1", name: "t1", runs: 4, tokens: 1000, cost: 2.0, costPerRun: 0.5 },
      { taskId: "t2", name: "t2", runs: 6, tokens: 3000, cost: 4.0, costPerRun: 4 / 6 },
    ]);

    // byModel passthrough mapped to contract shape
    expect(data.byModel).toEqual([
      { model: "claude-opus-4-6", cost: 5.0, tokens: 3000 },
      { model: "claude-haiku", cost: 1.0, tokens: 1000 },
    ]);

    // daily merged by timestamp, oldest -> newest
    expect(data.daily).toEqual([
      { date: "2026-06-06", cost: 1.0, tokens: 500 },
      { date: "2026-06-07", cost: 3.0, tokens: 2000 },
      { date: "2026-06-08", cost: 2.0, tokens: 1500 },
    ]);
  });

  it("treats null trace_token_cost as 0 and guards divide-by-zero", async () => {
    const client = makeClient({
      overview: {
        count: 1,
        overviews: [
          {
            task_id: "t1",
            trace_count: 0,
            trace_token_count: 0,
            trace_token_cost: null,
            eval_count: 0,
            continuous_eval_success_rate: 0,
          },
        ],
      },
      timeseries: { t1: [] },
      byModel: [],
    });

    const data = await collectCost(client, { now: NOW, bucketSize: "day" });

    expect(data.totals).toEqual({
      totalTokenCost: 0,
      totalTokens: 0,
      traceCount: 0,
      costPerRun: 0,
    });
    expect(data.byWorkflow).toEqual([
      { taskId: "t1", name: "t1", runs: 0, tokens: 0, cost: 0, costPerRun: 0 },
    ]);
    expect(data.byModel).toEqual([]);
    expect(data.daily).toEqual([]);
  });

  it("returns empty aggregates when Arthur has no tasks", async () => {
    const client = makeClient({
      overview: { count: 0, overviews: [] },
      timeseries: {},
      byModel: [],
    });

    const data = await collectCost(client, { now: NOW, bucketSize: "day" });

    expect(data.totals).toEqual({
      totalTokenCost: 0,
      totalTokens: 0,
      traceCount: 0,
      costPerRun: 0,
    });
    expect(data.byWorkflow).toEqual([]);
    expect(data.byModel).toEqual([]);
    expect(data.daily).toEqual([]);
    // No tasks -> no per-task timeseries fan-out.
    expect(client.getTracesTimeseries).not.toHaveBeenCalled();
  });

  it("caps the daily timeseries fan-out to the 50 most-active tasks", async () => {
    // 60 tasks, each with a distinct trace_count so the top-50 are deterministic.
    const overviews = Array.from({ length: 60 }, (_, i) => ({
      task_id: `t${i}`,
      trace_count: i, // t59 most active, t0 least
      trace_token_count: 0,
      trace_token_cost: 0,
      eval_count: 0,
      continuous_eval_success_rate: 0,
    }));
    const client = makeClient({
      overview: { count: overviews.length, overviews },
      timeseries: {},
      byModel: [],
    });

    await collectCost(client, { now: NOW, bucketSize: "day" });

    // Only the 50 highest-trace_count tasks are queried (t10..t59).
    expect(client.getTracesTimeseries).toHaveBeenCalledTimes(50);
    const queried = (client.getTracesTimeseries as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(queried).not.toContain("t0");
    expect(queried).not.toContain("t9");
    expect(queried).toContain("t10");
    expect(queried).toContain("t59");
  });
});
