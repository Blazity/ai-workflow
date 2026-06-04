import { describe, it, expect, vi } from "vitest";
import { collectKpis } from "./collect-kpis.js";
import type { RunsLister, WorkflowRunRecord } from "./collect-runs.js";

const NOW = new Date("2026-06-02T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function makeLister(records: WorkflowRunRecord[]): RunsLister {
  return { list: vi.fn().mockResolvedValue({ data: records }) };
}

function completed(id: string, startH: number, durSec: number): WorkflowRunRecord {
  const startedAt = hoursAgo(startH);
  return {
    runId: id,
    status: "completed",
    workflowName: "agentWorkflow",
    createdAt: startedAt,
    startedAt,
    completedAt: new Date(startedAt.getTime() + durSec * 1000),
  };
}

describe("collectKpis", () => {
  it("counts runs in the last 24h with delta vs the prior 24h", async () => {
    const lister = makeLister([
      completed("a", 1, 100),
      completed("b", 5, 200),
      completed("c", 23, 300),
      { ...completed("err", 2, 50), status: "failed" },
      // prior window (24-48h ago): 2 runs
      completed("p1", 30, 100),
      completed("p2", 40, 100),
    ]);

    const kpis = await collectKpis({ runsLister: lister, now: NOW });

    expect(kpis.runs24h).toMatchObject({ value: 4, deltaPct: 100 });
    expect(kpis.runs24h?.spark).toHaveLength(24);
    expect(kpis.errors24h).toMatchObject({ value: 1 });
    // p95 of [100, 200, 300] completed durations in last 24h
    expect(kpis.p95?.valueSec).toBe(300);
    expect(kpis.cost24h).toBeNull();
  });

  it("returns zeroed kpis (not null) when there are no runs", async () => {
    const kpis = await collectKpis({ runsLister: makeLister([]), now: NOW });
    expect(kpis.runs24h).toEqual({ value: 0, deltaPct: 0, spark: new Array(24).fill(0) });
    expect(kpis.p95?.valueSec).toBe(0);
    expect(kpis.cost24h).toBeNull();
  });
});
