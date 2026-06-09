import { describe, it, expect, vi } from "vitest";
import { collectEvals } from "./collect-evals.js";
import type { ArthurTask } from "../../sandbox/arthur-client.js";

const NOW = new Date("2026-06-08T12:00:00.000Z");

const TASKS: ArthurTask[] = [{ id: "a", name: "a" }, { id: "b", name: "b" }];

/**
 * Fake `EvalsArthurClient` where `countTraces` returns a different count per
 * eval-status filter: passed/failed for the status queries, an unfiltered total
 * otherwise.
 */
function makeClient(counts: { passed: number; failed: number; total: number }) {
  return {
    listAllTasks: vi.fn().mockResolvedValue(TASKS),
    countTraces: vi.fn(
      async (
        _ids: string[],
        _start: string,
        _end: string,
        filters?: Record<string, string>,
      ) => {
        const status = filters?.continuous_eval_run_status;
        if (status === "passed") return counts.passed;
        if (status === "failed") return counts.failed;
        return counts.total;
      },
    ),
  };
}

describe("collectEvals", () => {
  it("computes pass rate, graded count, and total from per-status counts", async () => {
    const client = makeClient({ passed: 8, failed: 2, total: 15 });

    const result = await collectEvals({ client, windowHours: 24, now: NOW });

    expect(result.score).toBe(80); // 8 / (8 + 2) * 100
    expect(result.spansGraded).toBe(10); // 8 + 2
    expect(result.traceCount).toBe(15);
    expect(result.windowHours).toBe(24);
  });

  it("yields score 0 / spansGraded 0 when nothing is graded", async () => {
    const client = makeClient({ passed: 0, failed: 0, total: 5 });

    const result = await collectEvals({ client, windowHours: 24, now: NOW });

    expect(result.score).toBe(0);
    expect(result.spansGraded).toBe(0);
    expect(result.traceCount).toBe(5);
  });

  it("enumerates tasks and queries the ISO window for each status", async () => {
    const client = makeClient({ passed: 1, failed: 1, total: 2 });

    await collectEvals({ client, windowHours: 24, now: NOW });

    expect(client.listAllTasks).toHaveBeenCalledTimes(1);
    expect(client.countTraces).toHaveBeenCalledWith(
      ["a", "b"],
      "2026-06-07T12:00:00.000Z",
      "2026-06-08T12:00:00.000Z",
      { continuous_eval_run_status: "passed" },
    );
    expect(client.countTraces).toHaveBeenCalledWith(
      ["a", "b"],
      "2026-06-07T12:00:00.000Z",
      "2026-06-08T12:00:00.000Z",
      { continuous_eval_run_status: "failed" },
    );
    expect(client.countTraces).toHaveBeenCalledWith(
      ["a", "b"],
      "2026-06-07T12:00:00.000Z",
      "2026-06-08T12:00:00.000Z",
    );
  });
});
