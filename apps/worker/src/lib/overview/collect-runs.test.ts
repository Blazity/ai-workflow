import { describe, it, expect, vi } from "vitest";
import { collectRuns, type RunsLister, type WorkflowRunRecord } from "./collect-runs.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";

function makeLister(records: WorkflowRunRecord[]): RunsLister {
  return { list: vi.fn().mockResolvedValue({ data: records }) };
}

function makeTracker(
  overrides: Partial<IssueTrackerAdapter> = {},
): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn().mockRejectedValue(new Error("not found")),
    moveTicket: vi.fn(),
    postComment: vi.fn().mockResolvedValue(null),
    searchTickets: vi.fn(),
    ...overrides,
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

describe("collectRuns", () => {
  it("maps runs to rows: status, duration (s), startedAtMin, workflow, ticket", async () => {
    const lister = makeLister([
      record({
        runId: "run_a",
        status: "completed",
        input: ["AWT-101"],
        startedAt: new Date("2026-06-02T11:00:00.000Z"), // 60m ago
        completedAt: new Date("2026-06-02T11:05:00.000Z"), // 300s
      }),
    ]);
    const tracker = makeTracker({
      fetchTicket: vi.fn(async (key: string) => ({
        id: key,
        identifier: key,
        projectKey: "AWT",
        title: "Fix the thing",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
        attachments: [],
      })),
    });

    const { rows, total, counts } = await collectRuns({
      runsLister: lister,
      issueTracker: tracker,
      jiraBaseUrl: "https://example.atlassian.net/",
      model: "claude-opus-4-8",
      now: NOW,
    });

    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      id: "run_a",
      status: "success",
      workflow: "wf_agent",
      workflowName: "Agent",
      ticket: "AWT-101",
      ticketTitle: "Fix the thing",
      ticketUrl: "https://example.atlassian.net/browse/AWT-101",
      actor: "ai-bot",
      model: "claude-opus-4-8",
      duration: 300,
      startedAtMin: 60,
      cost: null,
      tokens: null,
    });
    expect(counts).toEqual({
      success: 1,
      running: 0,
      awaiting: 0,
      failed: 0,
      blocked: 0,
    });
  });

  it("maps statuses and sorts newest-first; running has null duration", async () => {
    const lister = makeLister([
      record({
        runId: "old_failed",
        status: "failed",
        input: ["AWT-2"],
        startedAt: new Date("2026-06-02T10:00:00.000Z"),
        completedAt: new Date("2026-06-02T10:02:00.000Z"),
      }),
      record({
        runId: "newest_running",
        status: "running",
        input: ["AWT-3"],
        startedAt: new Date("2026-06-02T11:50:00.000Z"),
      }),
      record({
        runId: "cancelled_one",
        status: "cancelled",
        input: ["AWT-4"],
        startedAt: new Date("2026-06-02T11:00:00.000Z"),
        completedAt: new Date("2026-06-02T11:01:00.000Z"),
      }),
    ]);

    const { rows, counts } = await collectRuns({
      runsLister: lister,
      issueTracker: makeTracker(),
      jiraBaseUrl: "https://example.atlassian.net",
      model: "m",
      now: NOW,
    });

    expect(rows.map((r) => r.id)).toEqual([
      "newest_running",
      "cancelled_one",
      "old_failed",
    ]);
    expect(rows[0]).toMatchObject({ status: "running", duration: null });
    expect(counts).toMatchObject({ failed: 1, running: 1, blocked: 1 });
  });

  it("falls back to ticket key as title when tracker lookup fails", async () => {
    const lister = makeLister([record({ runId: "r", input: ["AWT-9"] })]);
    const { rows } = await collectRuns({
      runsLister: lister,
      issueTracker: makeTracker(),
      jiraBaseUrl: "https://example.atlassian.net",
      model: "m",
      now: NOW,
    });
    expect(rows[0].ticket).toBe("AWT-9");
    expect(rows[0].ticketTitle).toBe("AWT-9");
  });

  it("leaves ticket empty when input cannot be decoded to a ticket key", async () => {
    const lister = makeLister([
      record({ runId: "r", workflowName: "workflow//x//postPrGateWorkflow", input: undefined }),
    ]);
    const { rows } = await collectRuns({
      runsLister: lister,
      issueTracker: makeTracker(),
      jiraBaseUrl: "https://example.atlassian.net",
      model: "m",
      now: NOW,
    });
    expect(rows[0].ticket).toBe("");
    expect(rows[0].ticketUrl).toBe("");
    expect(rows[0].workflow).toBe("wf_post_pr_gate");
    expect(rows[0].workflowName).toBe("Post-PR gate");
  });

  it("returns empty result for no runs", async () => {
    const { rows, total } = await collectRuns({
      runsLister: makeLister([]),
      issueTracker: makeTracker(),
      jiraBaseUrl: "https://example.atlassian.net",
      model: "m",
      now: NOW,
    });
    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });
});
