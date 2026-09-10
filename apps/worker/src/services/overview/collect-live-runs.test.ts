import { describe, it, expect, vi } from "vitest";
import { collectLiveRuns } from "./collect-live-runs.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";

/** Pre-attribution shorthand: label every requested run id with one model. */
function attributeAll(
  model: string,
): (runIds: string[]) => Promise<ReadonlyMap<string, string>> {
  return async (runIds) => new Map(runIds.map((runId) => [runId, model]));
}

function makeRegistry(
  entries: Array<{
    ticketKey: string;
    runId: string;
    state?: "bound" | "parking" | "parked";
  }>,
): RunRegistryAdapter {
  const active = entries.map((entry) => ({
    ...entry,
    subjectKey: `ticket:jira:${entry.ticketKey}`,
    ownerToken: `owner:${entry.runId}`,
    state: entry.state ?? ("bound" as const),
    kind: "ticket" as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  return {
    reserve: vi.fn(),
    commitStartedRun: vi.fn(),
    markRunEntryStarted: vi.fn(),
    bindRun: vi.fn(),
    beginParking: vi.fn(),
    finishParking: vi.fn(),
    handoff: vi.fn(),
    get: vi.fn(),
    beginCancellation: vi.fn(),
    releaseCancellation: vi.fn(),
    releaseReservation: vi.fn(),
    release: vi.fn(),
    listAll: vi.fn().mockResolvedValue(active),
    registerSandbox: vi.fn(),
    listSandboxes: vi.fn(),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  };
}

function makeTracker(
  overrides: Partial<IssueTrackerAdapter> = {},
): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn(),
    moveTicket: vi.fn(),
    postComment: vi.fn().mockResolvedValue(null),
    searchTickets: vi.fn(),
    ...overrides,
  };
}

describe("collectLiveRuns", () => {
  it("maps registry entries to Run rows with ticket titles", async () => {
    const registry = makeRegistry([
      { ticketKey: "AWT-101", runId: "run_a" },
      { ticketKey: "AWT-102", runId: "run_b" },
    ]);
    const tracker = makeTracker({
      fetchTicket: vi.fn(async (key: string) => ({
        id: key,
        identifier: key,
        projectKey: "AWT",
        title: key === "AWT-101" ? "First ticket" : "Second ticket",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
        attachments: [],
      })),
    });

    const rows = await collectLiveRuns({
      registry,
      issueTracker: tracker,
      jiraBaseUrl: "https://example.atlassian.net",
      resolveModels: attributeAll("claude-opus-4-7"),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "run_a",
      ticket: "AWT-101",
      ticketTitle: "First ticket",
      ticketUrl: "https://example.atlassian.net/browse/AWT-101",
      status: "running",
      workflow: "wf_agent",
      workflowName: "Agent",
      actor: "ai-bot",
      model: "claude-opus-4-7",
    });
    expect(rows[1].ticket).toBe("AWT-102");
    expect(rows[1].ticketTitle).toBe("Second ticket");
  });

  it("carries the attributed model per run, and null for a run with none", async () => {
    const registry = makeRegistry([
      { ticketKey: "AWT-1", runId: "run_attributed" },
      { ticketKey: "AWT-2", runId: "run_unknown" },
    ]);

    const rows = await collectLiveRuns({
      registry,
      issueTracker: makeTracker(),
      jiraBaseUrl: "https://example.atlassian.net",
      // Only the first run has attributable evidence; the second must not be
      // labelled with the org default (AIW-253).
      resolveModels: async (runIds) => {
        expect(runIds).toEqual(["run_attributed", "run_unknown"]);
        return new Map([["run_attributed", "gpt-5.6-sol"]]);
      },
    });

    expect(rows.map(({ id, model }) => ({ id, model }))).toEqual([
      { id: "run_attributed", model: "gpt-5.6-sol" },
      { id: "run_unknown", model: null },
    ]);
  });

  it("falls back to the ticket key when issue tracker lookup fails", async () => {
    const registry = makeRegistry([{ ticketKey: "AWT-999", runId: "run_x" }]);
    const tracker = makeTracker({
      fetchTicket: vi.fn().mockRejectedValue(new Error("not found")),
    });

    const rows = await collectLiveRuns({
      registry,
      issueTracker: tracker,
      jiraBaseUrl: "https://example.atlassian.net",
      resolveModels: attributeAll("claude-opus-4-7"),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticket: "AWT-999",
      ticketTitle: "AWT-999",
      ticketUrl: "https://example.atlassian.net/browse/AWT-999",
    });
  });

  it("returns an empty array when the registry is empty", async () => {
    const rows = await collectLiveRuns({
      registry: makeRegistry([]),
      issueTracker: makeTracker(),
      jiraBaseUrl: "https://example.atlassian.net",
      resolveModels: attributeAll("claude-opus-4-7"),
    });
    expect(rows).toEqual([]);
  });

  it("renders parking as running and durable parked state as awaiting", async () => {
    const rows = await collectLiveRuns({
      registry: makeRegistry([
        { ticketKey: "AWT-1", runId: "run-parking", state: "parking" },
        { ticketKey: "AWT-2", runId: "run-parked", state: "parked" },
      ]),
      issueTracker: makeTracker(),
      jiraBaseUrl: "https://example.atlassian.net",
      resolveModels: attributeAll("claude-opus-4-7"),
    });

    expect(rows.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "run-parking", status: "running" },
      { id: "run-parked", status: "awaiting" },
    ]);
  });

  it("strips trailing slashes from the Jira base URL when building ticketUrl", async () => {
    const registry = makeRegistry([{ ticketKey: "AWT-7", runId: "run_z" }]);
    const tracker = makeTracker({
      fetchTicket: vi.fn(async () => ({
        id: "AWT-7",
        identifier: "AWT-7",
        projectKey: "AWT",
        title: "Trim slash",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
        attachments: [],
      })),
    });

    const rows = await collectLiveRuns({
      registry,
      issueTracker: tracker,
      jiraBaseUrl: "https://example.atlassian.net/",
      resolveModels: attributeAll("claude-opus-4-7"),
    });

    expect(rows[0].ticketUrl).toBe("https://example.atlassian.net/browse/AWT-7");
  });
});
