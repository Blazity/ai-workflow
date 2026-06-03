import { describe, it, expect, vi } from "vitest";
import { collectAwaitingRuns } from "./collect-awaiting-runs.js";
import type {
  IssueTrackerAdapter,
  TicketComment,
} from "../../adapters/issue-tracker/types.js";

const BOT = "bot-account-id";
const NOW = new Date("2026-06-03T12:00:00.000Z");

function ticket(key: string, comments: TicketComment[], title = `Title ${key}`) {
  return {
    id: key,
    identifier: key,
    projectKey: "AWT",
    title,
    description: "",
    acceptanceCriteria: "",
    comments,
    labels: ["needs-clarification"],
    trackerStatus: "Backlog",
    attachments: [],
  };
}

function makeTracker(
  overrides: Partial<IssueTrackerAdapter> = {},
): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn(),
    moveTicket: vi.fn(),
    postComment: vi.fn().mockResolvedValue(null),
    searchTickets: vi.fn().mockResolvedValue([]),
    getCurrentUserAccountId: vi.fn().mockResolvedValue(BOT),
    ...overrides,
  };
}

const base = {
  projectKey: "AWT",
  backlogColumn: "Backlog",
  jiraBaseUrl: "https://example.atlassian.net",
  model: "claude-opus-4-8",
  now: NOW,
};

describe("collectAwaitingRuns", () => {
  it("emits an awaiting row when the latest comment is the bot's", async () => {
    const tracker = makeTracker({
      searchTickets: vi.fn().mockResolvedValue(["AWT-1"]),
      fetchTicket: vi.fn(async (key: string) =>
        ticket(key, [
          {
            author: "Bot",
            accountId: BOT,
            body: "1. Which environment?",
            createdAt: "2026-06-03T11:30:00.000Z",
          },
        ]),
      ),
    });

    const rows = await collectAwaitingRuns({ ...base, issueTracker: tracker });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "awaiting:AWT-1",
      ticket: "AWT-1",
      status: "awaiting",
      question: "1. Which environment?",
      askedAtMin: 30,
      ticketUrl: "https://example.atlassian.net/browse/AWT-1",
    });
  });

  it("drops tickets where a human replied after the bot", async () => {
    const tracker = makeTracker({
      searchTickets: vi.fn().mockResolvedValue(["AWT-2"]),
      fetchTicket: vi.fn(async (key: string) =>
        ticket(key, [
          {
            author: "Bot",
            accountId: BOT,
            body: "1. Which env?",
            createdAt: "2026-06-03T11:00:00.000Z",
          },
          {
            author: "Human",
            accountId: "human-account-id",
            body: "Production",
            createdAt: "2026-06-03T11:45:00.000Z",
          },
        ]),
      ),
    });

    const rows = await collectAwaitingRuns({ ...base, issueTracker: tracker });
    expect(rows).toEqual([]);
  });

  it("returns [] when the tracker can't identify the bot", async () => {
    const tracker = makeTracker({ getCurrentUserAccountId: undefined });
    const rows = await collectAwaitingRuns({ ...base, issueTracker: tracker });
    expect(rows).toEqual([]);
  });

  it("skips unreadable tickets without blanking the rest", async () => {
    const tracker = makeTracker({
      searchTickets: vi.fn().mockResolvedValue(["AWT-3", "AWT-4"]),
      fetchTicket: vi.fn(async (key: string) => {
        if (key === "AWT-3") throw new Error("boom");
        return ticket(key, [
          {
            author: "Bot",
            accountId: BOT,
            body: "Need info",
            createdAt: "2026-06-03T11:00:00.000Z",
          },
        ]);
      }),
    });

    const rows = await collectAwaitingRuns({ ...base, issueTracker: tracker });
    expect(rows).toHaveLength(1);
    expect(rows[0].ticket).toBe("AWT-4");
  });
});
