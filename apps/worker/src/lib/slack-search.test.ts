import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeOldest,
  matchMessages,
  searchSlackChannels,
} from "./slack-search.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const NOW = new Date(1_800_000_000_000); // fixed point in time for deterministic oldest
const OLDEST_10_DAYS = "1799136000.000000"; // 1800000000 - 10 * 86400 seconds

function slackOk(body: Record<string, unknown>) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body };
}

function historyCalls() {
  return mockFetch.mock.calls.filter(([url]) =>
    String(url).includes("/conversations.history"),
  );
}

function permalinkCalls() {
  return mockFetch.mock.calls.filter(([url]) =>
    String(url).includes("/chat.getPermalink"),
  );
}

describe("computeOldest", () => {
  it("subtracts lookback days and formats a Slack timestamp", () => {
    expect(computeOldest(NOW, 10)).toBe(OLDEST_10_DAYS);
  });

  it("returns now itself for zero lookback", () => {
    expect(computeOldest(NOW, 0)).toBe("1800000000.000000");
  });
});

describe("matchMessages", () => {
  const messages = [
    { ts: "1.000001", text: "The LOGIN button is broken" },
    { ts: "2.000002", text: "the Payment Flow is down" },
    { ts: "3.000003", text: "unrelated chatter" },
    { ts: "4.000004" },
  ];

  it("matches case-insensitively in both directions", () => {
    expect(matchMessages(messages, ["login"]).map((m) => m.ts)).toEqual([
      "1.000001",
    ]);
    expect(matchMessages(messages, ["PAYMENT FLOW"]).map((m) => m.ts)).toEqual([
      "2.000002",
    ]);
  });

  it("treats a multi-word keyword as one phrase", () => {
    expect(matchMessages(messages, ["payment flow"]).map((m) => m.ts)).toEqual([
      "2.000002",
    ]);
    expect(matchMessages(messages, ["flow is"]).map((m) => m.ts)).toEqual([
      "2.000002",
    ]);
    expect(matchMessages(messages, ["payment down"])).toEqual([]);
  });

  it("matches when any single keyword hits", () => {
    expect(
      matchMessages(messages, ["nope", "chatter", "login"]).map((m) => m.ts),
    ).toEqual(["1.000001", "3.000003"]);
  });

  it("returns nothing for empty or blank keywords", () => {
    expect(matchMessages(messages, [])).toEqual([]);
    expect(matchMessages(messages, ["  "])).toEqual([]);
  });
});

describe("searchSlackChannels", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("fetches history with oldest and resolves permalinks for matches", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/conversations.history")) {
        return slackOk({
          ok: true,
          messages: [
            { ts: "1799999000.000100", text: "The LOGIN button is broken" },
            { ts: "1799998000.000200", text: "unrelated chatter" },
          ],
          has_more: false,
        });
      }
      return slackOk({
        ok: true,
        permalink: "https://slack.example/archives/C1/p1799999000000100",
      });
    });

    const result = await searchSlackChannels({
      token: "test-token",
      channels: ["C1"],
      keywords: ["login"],
      lookbackDays: 10,
      maxResults: 10,
      now: NOW,
    });

    expect(result).toEqual({
      matches: [
        {
          channel: "C1",
          ts: "1799999000.000100",
          text: "The LOGIN button is broken",
          permalink: "https://slack.example/archives/C1/p1799999000000100",
        },
      ],
      skippedChannels: [],
    });

    const history = historyCalls();
    expect(history).toHaveLength(1);
    const historyUrl = history[0][0] as string;
    expect(historyUrl).toContain("channel=C1");
    expect(historyUrl).toContain(`oldest=${OLDEST_10_DAYS}`);
    expect(
      (history[0][1] as RequestInit).headers as Record<string, string>,
    ).toEqual({ Authorization: "Bearer test-token" });

    const permalinks = permalinkCalls();
    expect(permalinks).toHaveLength(1);
    expect(permalinks[0][0]).toContain("message_ts=1799999000.000100");
  });

  it("puts a channel without the bot into skippedChannels instead of throwing", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/conversations.history")) {
        const parsed = new URL(url);
        if (parsed.searchParams.get("channel") === "C_PRIVATE") {
          return slackOk({ ok: false, error: "not_in_channel" });
        }
        return slackOk({
          ok: true,
          messages: [{ ts: "1.000001", text: "login broken" }],
          has_more: false,
        });
      }
      return slackOk({ ok: true, permalink: "https://slack.example/p/1" });
    });

    const result = await searchSlackChannels({
      token: "test-token",
      channels: ["C_PRIVATE", "C_OPEN"],
      keywords: ["login"],
      lookbackDays: 10,
      maxResults: 10,
      now: NOW,
    });

    expect(result.skippedChannels).toEqual(["C_PRIVATE"]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].channel).toBe("C_OPEN");
  });

  it("caps pagination at 3 pages per channel", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/conversations.history")) {
        return slackOk({
          ok: true,
          messages: [{ ts: "1.000001", text: "login broken" }],
          has_more: true,
          response_metadata: { next_cursor: "next-cursor" },
        });
      }
      return slackOk({ ok: true, permalink: "https://slack.example/p/1" });
    });

    const result = await searchSlackChannels({
      token: "test-token",
      channels: ["C1"],
      keywords: ["login"],
      lookbackDays: 10,
      maxResults: 10,
      now: NOW,
    });

    const history = historyCalls();
    expect(history).toHaveLength(3);
    expect(new URL(history[0][0] as string).searchParams.get("cursor")).toBeNull();
    expect(new URL(history[1][0] as string).searchParams.get("cursor")).toBe(
      "next-cursor",
    );
    expect(result.matches).toHaveLength(3);
  });

  it("trims matches to maxResults and only fetches permalinks for them", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/conversations.history")) {
        return slackOk({
          ok: true,
          messages: [
            { ts: "1.000001", text: "login broken" },
            { ts: "2.000002", text: "login still broken" },
            { ts: "3.000003", text: "login works again" },
          ],
          has_more: false,
        });
      }
      return slackOk({ ok: true, permalink: "https://slack.example/p/1" });
    });

    const result = await searchSlackChannels({
      token: "test-token",
      channels: ["C1"],
      keywords: ["login"],
      lookbackDays: 10,
      maxResults: 2,
      now: NOW,
    });

    expect(result.matches.map((m) => m.ts)).toEqual(["1.000001", "2.000002"]);
    expect(permalinkCalls()).toHaveLength(2);
  });

  it("returns empty results for an empty history without calling getPermalink", async () => {
    mockFetch.mockImplementation(async () =>
      slackOk({ ok: true, messages: [], has_more: false }),
    );

    const result = await searchSlackChannels({
      token: "test-token",
      channels: ["C1"],
      keywords: ["login"],
      lookbackDays: 10,
      maxResults: 10,
      now: NOW,
    });

    expect(result).toEqual({ matches: [], skippedChannels: [] });
    expect(permalinkCalls()).toHaveLength(0);
  });

  it("keeps the match with an empty permalink when getPermalink fails", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/conversations.history")) {
        return slackOk({
          ok: true,
          messages: [{ ts: "1.000001", text: "login broken" }],
          has_more: false,
        });
      }
      return slackOk({ ok: false, error: "message_not_found" });
    });

    const result = await searchSlackChannels({
      token: "test-token",
      channels: ["C1"],
      keywords: ["login"],
      lookbackDays: 10,
      maxResults: 10,
      now: NOW,
    });

    expect(result.matches).toEqual([
      {
        channel: "C1",
        ts: "1.000001",
        text: "login broken",
        permalink: "",
      },
    ]);
  });
});
