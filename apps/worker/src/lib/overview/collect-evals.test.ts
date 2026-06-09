import { describe, it, expect, vi } from "vitest";
import { collectEvals } from "./collect-evals.js";
import type { TraceOverview } from "../../sandbox/arthur-client.js";

const NOW = new Date("2026-06-08T12:00:00.000Z");

function makeClient(overviews: TraceOverview[]) {
  return { getTracesOverview: vi.fn().mockResolvedValue({ overviews }) };
}

function overview(over: Partial<TraceOverview>): TraceOverview {
  return {
    task_id: "t",
    trace_count: 0,
    trace_token_count: 0,
    trace_token_cost: 0,
    eval_count: 0,
    continuous_eval_success_rate: 0,
    ...over,
  };
}

describe("collectEvals", () => {
  it("sums spansGraded/traceCount and eval-count-weights the score", async () => {
    const client = makeClient([
      overview({ task_id: "a", trace_count: 10, eval_count: 8, continuous_eval_success_rate: 1.0 }),
      overview({ task_id: "b", trace_count: 4, eval_count: 2, continuous_eval_success_rate: 0.5 }),
    ]);

    const result = await collectEvals({
      client,
      taskIds: [],
      windowHours: 24,
      now: NOW,
    });

    expect(result.spansGraded).toBe(10);
    expect(result.traceCount).toBe(14);
    // (1.0*8 + 0.5*2) / 10 * 100 = (8 + 1) / 10 * 100 = 90
    expect(result.score).toBe(90);
    expect(result.windowHours).toBe(24);
  });

  it("yields score 0 when nothing is graded (eval_count sums to 0)", async () => {
    const client = makeClient([
      overview({ task_id: "a", trace_count: 5, eval_count: 0 }),
    ]);

    const result = await collectEvals({
      client,
      taskIds: [],
      windowHours: 24,
      now: NOW,
    });

    expect(result.spansGraded).toBe(0);
    expect(result.traceCount).toBe(5);
    expect(result.score).toBe(0);
  });

  it("computes the window start from windowHours and passes the ISO range to the client", async () => {
    const client = makeClient([]);

    await collectEvals({
      client,
      taskIds: ["x", "y"],
      windowHours: 24,
      now: NOW,
    });

    expect(client.getTracesOverview).toHaveBeenCalledWith(
      ["x", "y"],
      "2026-06-07T12:00:00.000Z",
      "2026-06-08T12:00:00.000Z",
    );
  });

  it("returns zeroed aggregates when no overviews are returned", async () => {
    const client = makeClient([]);

    const result = await collectEvals({
      client,
      taskIds: [],
      windowHours: 24,
      now: NOW,
    });

    expect(result).toEqual({
      windowHours: 24,
      score: 0,
      spansGraded: 0,
      traceCount: 0,
    });
  });
});
