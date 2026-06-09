import { describe, it, expect, vi } from "vitest";
import { collectCost, type CostArthurClient } from "./collect-cost.js";
import type { ArthurTask, TraceRow } from "../../sandbox/arthur-client.js";

const NOW = new Date("2026-06-08T12:00:00.000Z");

function makeClient(opts: { tasks: ArthurTask[]; traces: TraceRow[] }): CostArthurClient {
  return {
    listAllTasks: vi.fn().mockResolvedValue(opts.tasks),
    listTraces: vi.fn().mockResolvedValue(opts.traces),
  };
}

describe("collectCost", () => {
  it("aggregates totals, per-task breakdown, and merged daily series", async () => {
    const client = makeClient({
      tasks: [
        { id: "t1", name: "AWT-1" },
        { id: "t2", name: "AWT-2" },
      ],
      traces: [
        { task_id: "t1", total_token_count: 500, total_token_cost: 1.0, start_time: "2026-06-06T08:00:00Z" },
        { task_id: "t1", total_token_count: 500, total_token_cost: 1.0, start_time: "2026-06-07T08:00:00Z" },
        { task_id: "t2", total_token_count: 1500, total_token_cost: 2.0, start_time: "2026-06-07T09:00:00Z" },
        { task_id: "t2", total_token_count: 1500, total_token_cost: 2.0, start_time: "2026-06-08T09:00:00Z" },
      ],
    });

    const data = await collectCost(client, { now: NOW });

    expect(data.totals).toEqual({
      totalTokenCost: 6.0,
      totalTokens: 4000,
      traceCount: 4,
      costPerRun: 1.5,
    });

    // window = calendar MTD
    expect(data.window.start).toBe("2026-06-01T00:00:00.000Z");
    expect(data.window.end).toBe(NOW.toISOString());

    // byWorkflow = per-task, name from the task list, costPerRun guarded
    expect(data.byWorkflow).toEqual([
      { taskId: "t1", name: "AWT-1", runs: 2, tokens: 1000, cost: 2.0, costPerRun: 1.0 },
      { taskId: "t2", name: "AWT-2", runs: 2, tokens: 3000, cost: 4.0, costPerRun: 2.0 },
    ]);

    // daily bucketed by start_time day, oldest -> newest
    expect(data.daily).toEqual([
      { date: "2026-06-06", cost: 1.0, tokens: 500 },
      { date: "2026-06-07", cost: 3.0, tokens: 2000 },
      { date: "2026-06-08", cost: 2.0, tokens: 1500 },
    ]);
  });

  it("treats null total_token_cost as 0", async () => {
    const client = makeClient({
      tasks: [{ id: "t1", name: "AWT-1" }],
      traces: [
        { task_id: "t1", total_token_count: 100, total_token_cost: null, start_time: "2026-06-08T00:00:00Z" },
        { task_id: "t1", total_token_count: 200, total_token_cost: 0.5, start_time: "2026-06-08T01:00:00Z" },
      ],
    });

    const data = await collectCost(client, { now: NOW });

    expect(data.totals).toEqual({
      totalTokenCost: 0.5,
      totalTokens: 300,
      traceCount: 2,
      costPerRun: 0.25,
    });
    expect(data.byWorkflow).toEqual([
      { taskId: "t1", name: "AWT-1", runs: 2, tokens: 300, cost: 0.5, costPerRun: 0.25 },
    ]);
    expect(data.daily).toEqual([{ date: "2026-06-08", cost: 0.5, tokens: 300 }]);
  });

  it("returns zeroed totals and empty aggregates when there are no traces", async () => {
    const client = makeClient({
      tasks: [{ id: "t1", name: "AWT-1" }],
      traces: [],
    });

    const data = await collectCost(client, { now: NOW });

    expect(data.totals).toEqual({
      totalTokenCost: 0,
      totalTokens: 0,
      traceCount: 0,
      costPerRun: 0,
    });
    expect(data.byWorkflow).toEqual([]);
    expect(data.daily).toEqual([]);
  });
});
