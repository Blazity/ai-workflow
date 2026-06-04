import { describe, it, expect, vi } from "vitest";

// workflow-registry.ts reads env.AGENT_KIND at import; stub it so the registry
// loads without the full env validation.
vi.mock("../../../env.js", () => ({ env: { AGENT_KIND: "claude" } }));

import { collectWorkflows } from "./collect-workflows.js";
import type { RunsLister, WorkflowRunRecord } from "./collect-runs.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";

function makeLister(records: WorkflowRunRecord[]): RunsLister {
  return { list: vi.fn().mockResolvedValue({ data: records }) };
}

function makeTracker(): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn().mockRejectedValue(new Error("not found")),
    moveTicket: vi.fn(),
    postComment: vi.fn().mockResolvedValue(null),
    searchTickets: vi.fn(),
  };
}

const NOW = new Date("2026-06-02T12:00:00.000Z");
const AGENT = "workflow//./src/workflows/agent//agentWorkflow";

function record(over: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    runId: "run",
    status: "completed",
    workflowName: AGENT,
    input: ["AWT-1"],
    createdAt: NOW,
    ...over,
  };
}

function run(opts: {
  runsLister: RunsLister;
}) {
  return collectWorkflows({
    runsLister: opts.runsLister,
    issueTracker: makeTracker(),
    jiraBaseUrl: "https://example.atlassian.net",
    projectKey: "AWT",
    model: "claude-opus-4-8",
    now: NOW,
  });
}

describe("collectWorkflows", () => {
  it("returns a row per registry workflow with null metrics when there are no runs", async () => {
    const { rows, total } = await run({ runsLister: makeLister([]) });

    expect(total).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(0);
    const agent = rows.find((r) => r.id === "wf_agent");
    expect(agent).toMatchObject({
      runs24h: 0,
      p50: null,
      p95: null,
      errRate: null,
      costToday: null,
      latestRun: null,
      trend24h: null,
    });
  });

  it("aggregates runs24h, p95, errRate and trend for the matching workflow", async () => {
    const { rows } = await run({
      runsLister: makeLister([
        record({
          runId: "a",
          status: "completed",
          startedAt: new Date("2026-06-02T11:00:00.000Z"), // 60m ago
          completedAt: new Date("2026-06-02T11:01:40.000Z"), // 100s
        }),
        record({
          runId: "b",
          status: "completed",
          startedAt: new Date("2026-06-02T11:30:00.000Z"), // 30m ago
          completedAt: new Date("2026-06-02T11:33:20.000Z"), // 200s
        }),
        record({
          runId: "c",
          status: "failed",
          startedAt: new Date("2026-06-02T11:45:00.000Z"), // 15m ago
          completedAt: new Date("2026-06-02T11:45:30.000Z"), // 30s
        }),
      ]),
    });

    const agent = rows.find((r) => r.id === "wf_agent");
    expect(agent).toBeDefined();
    expect(agent!.runs24h).toBe(3);
    expect(agent!.errRate).toBeCloseTo(1 / 3);
    expect(agent!.costToday).toBeNull();
    // p95 over [30, 100, 200] -> 200s; latest run is the 15m-ago "c".
    expect(agent!.p95).toBe(200);
    expect(agent!.latestRun?.ticket).toBe("AWT-1");
    // 24 buckets, three runs all within the most recent hour bucket (index 23).
    expect(agent!.trend24h).toHaveLength(24);
    expect(agent!.trend24h!.reduce((s, n) => s + n, 0)).toBe(3);

    // Workflows with no runs keep null metrics.
    const idle = rows.find((r) => r.id === "wf_post_pr_gate");
    expect(idle).toMatchObject({ runs24h: 0, trend24h: null });
  });

  it("excludes runs older than 24h from metrics but keeps latestRun", async () => {
    const { rows } = await run({
      runsLister: makeLister([
        record({
          runId: "old",
          status: "completed",
          startedAt: new Date("2026-05-30T12:00:00.000Z"), // 3 days ago
          completedAt: new Date("2026-05-30T12:05:00.000Z"),
        }),
      ]),
    });

    const agent = rows.find((r) => r.id === "wf_agent");
    expect(agent!.runs24h).toBe(0);
    expect(agent!.p95).toBeNull();
    expect(agent!.trend24h).toBeNull();
    // latestRun ignores the window so the latest ticket persists.
    expect(agent!.latestRun?.ticket).toBe("AWT-1");
  });
});
