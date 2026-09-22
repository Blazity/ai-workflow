/**
 * Keyword search over recent channel history, exercised only through
 * `searchSlackChannels`, which is the one exported surface (`computeOldest`
 * and `matchMessages` are module-private on purpose).
 *
 * The behaviours that matter to a person configuring this: the lookback
 * window is computed correctly, matching is forgiving (case, phrase, any
 * keyword, unicode), a channel the bot cannot see never fails the whole
 * search, pagination and maxResults are bounded, and every kind of failure
 * (permission, HTTP error, timeout, a bad permalink) turns into a skip with a
 * reason instead of a thrown error or a broken match.
 *
 * Ported from `apps/worker/src/services/slack/slack-search.test.ts`, which was
 * deleted when the module moved to `integrations/slack/search.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { MessageSearchOutcome, MessageSearchQuery } from "@integrations/sdk";
import { slackApi } from "./api";
import { searchSlackChannels } from "./search";

const NOW = new Date(1_800_000_000_000);
const OLDEST_10_DAYS = "1799136000.000000";

interface Call {
  method: string;
  /** The arguments, from the query string of a GET or the form body of a POST. */
  body: Record<string, string>;
  httpMethod: string;
}

/** A Slack that answers from a script keyed by method, and records what it was asked. */
function fakeSlack(handler: (method: string, body: Record<string, string>) => unknown) {
  const calls: Call[] = [];
  const http = {
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      const method = url.pathname.split("/").pop()!;
      const body = Object.fromEntries(
        init?.body === undefined ? url.searchParams : new URLSearchParams(String(init.body)),
      );
      calls.push({ method, body, httpMethod: init?.method ?? "GET" });
      return new Response(JSON.stringify(handler(method, body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { calls, api: slackApi(http, "xoxb-test") };
}

function historyCalls(calls: Call[]) {
  return calls.filter((c) => c.method === "conversations.history");
}

function permalinkCalls(calls: Call[]) {
  return calls.filter((c) => c.method === "chat.getPermalink");
}

/**
 * The successful half of the answer. A search that reports a failure instead
 * of results is a different case, asserted where that is the point, so every
 * other test may read `matches` and `skipped` directly.
 */
function found(outcome: MessageSearchOutcome): Extract<MessageSearchOutcome, { ok: true }> {
  assert.ok(outcome.ok, "the search reported a failure rather than results");
  return outcome;
}

function query(overrides: Partial<MessageSearchQuery> = {}): MessageSearchQuery {
  return {
    channels: ["C1"],
    keywords: ["login"],
    lookbackDays: 10,
    maxResults: 10,
    ...overrides,
  };
}

test("fetches history with the computed oldest and resolves a permalink for the one match", async () => {
  const slack = fakeSlack((method) => {
    if (method === "conversations.history") {
      return {
        ok: true,
        messages: [
          { ts: "1799999000.000100", text: "The LOGIN button is broken", user: "U42" },
          { ts: "1799998000.000200", text: "unrelated chatter" },
        ],
        has_more: false,
      };
    }
    return { ok: true, permalink: "https://slack.example/archives/C1/p1799999000000100" };
  });

  const result = await searchSlackChannels(slack.api, query(), NOW);

  assert.deepEqual(result, {
    ok: true,
    matches: [
      {
        channel: "C1",
        author: "U42",
        text: "The LOGIN button is broken",
        url: "https://slack.example/archives/C1/p1799999000000100",
        postedAt: new Date(Number("1799999000.000100") * 1000).toISOString(),
        id: "1799999000.000100",
      },
    ],
    skipped: [],
  });

  const history = historyCalls(slack.calls);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.body.channel, "C1");
  assert.equal(history[0]!.body.oldest, OLDEST_10_DAYS);

  const permalinks = permalinkCalls(slack.calls);
  assert.equal(permalinks.length, 1);
  assert.equal(permalinks[0]!.body.message_ts, "1799999000.000100");
});

test("matches keywords case-insensitively, as a phrase, and unicode diacritics case-insensitively", async () => {
  const messages = [
    { ts: "1.000001", text: "zaloguj się nie działa" },
    { ts: "2.000002", text: "ZAŻÓŁĆ gęślą jaźń" },
    { ts: "3.000003", text: "unrelated chatter" },
  ];
  const slack = fakeSlack((method) => {
    if (method === "conversations.history") return { ok: true, messages, has_more: false };
    return { ok: true, permalink: "https://slack.example/p" };
  });

  const byUpper = await searchSlackChannels(slack.api, query({ keywords: ["ZALOGUJ"] }), NOW);
  assert.deepEqual(found(byUpper).matches.map((m) => m.id), ["1.000001"]);

  const byDiacritics = await searchSlackChannels(slack.api, query({ keywords: ["zażółć"] }), NOW);
  assert.deepEqual(found(byDiacritics).matches.map((m) => m.id), ["2.000002"]);
});

test("matches when any of several keywords hits, and returns nothing for blank keywords", async () => {
  const messages = [
    { ts: "1.000001", text: "the login button is broken" },
    { ts: "2.000002", text: "the payment flow is down" },
    { ts: "3.000003", text: "unrelated chatter" },
  ];
  const slack = fakeSlack((method) => {
    if (method === "conversations.history") return { ok: true, messages, has_more: false };
    return { ok: true, permalink: "https://slack.example/p" };
  });

  const any = await searchSlackChannels(slack.api, query({ keywords: ["nope", "chatter"] }), NOW);
  assert.deepEqual(found(any).matches.map((m) => m.id), ["3.000003"]);

  const phrase = await searchSlackChannels(slack.api, query({ keywords: ["payment flow"] }), NOW);
  assert.deepEqual(found(phrase).matches.map((m) => m.id), ["2.000002"]);

  const blank = await searchSlackChannels(slack.api, query({ keywords: ["   "] }), NOW);
  assert.deepEqual(found(blank).matches, []);
});

test("reports a channel the bot cannot see as a permission skip, and still returns the other channel's matches", async () => {
  const slack = fakeSlack((method, body) => {
    if (method === "conversations.history") {
      if (body.channel === "C_PRIVATE") {
        return { ok: false, error: "not_in_channel" };
      }
      return { ok: true, messages: [{ ts: "1.000001", text: "login broken" }], has_more: false };
    }
    return { ok: true, permalink: "https://slack.example/p" };
  });

  const result = await searchSlackChannels(
    slack.api,
    query({ channels: ["C_PRIVATE", "C_OPEN"] }),
    NOW,
  );

  assert.deepEqual(found(result).skipped, [{ channel: "C_PRIVATE", reason: "permission" }]);
  assert.equal(found(result).matches.length, 1);
  assert.equal(found(result).matches[0]!.channel, "C_OPEN");
});

test("caps pagination at 3 pages per channel", async () => {
  const slack = fakeSlack((method) => {
    if (method === "conversations.history") {
      return {
        ok: true,
        messages: [{ ts: "1.000001", text: "login broken" }],
        has_more: true,
        response_metadata: { next_cursor: "next-cursor" },
      };
    }
    return { ok: true, permalink: "https://slack.example/p" };
  });

  const result = await searchSlackChannels(slack.api, query(), NOW);

  const history = historyCalls(slack.calls);
  assert.equal(history.length, 3);
  assert.equal(history[0]!.body.cursor, undefined);
  assert.equal(history[1]!.body.cursor, "next-cursor");
  assert.equal(found(result).matches.length, 3);
});

test("trims matches to maxResults and only asks for permalinks on the kept ones", async () => {
  const slack = fakeSlack((method) => {
    if (method === "conversations.history") {
      return {
        ok: true,
        messages: [
          { ts: "1.000001", text: "login broken" },
          { ts: "2.000002", text: "login still broken" },
          { ts: "3.000003", text: "login works again" },
        ],
        has_more: false,
      };
    }
    return { ok: true, permalink: "https://slack.example/p" };
  });

  const result = await searchSlackChannels(slack.api, query({ maxResults: 2 }), NOW);

  assert.deepEqual(found(result).matches.map((m) => m.id), ["1.000001", "2.000002"]);
  assert.equal(permalinkCalls(slack.calls).length, 2);
});

test("returns empty results for an empty history without asking for a permalink", async () => {
  const slack = fakeSlack(() => ({ ok: true, messages: [], has_more: false }));

  const result = await searchSlackChannels(slack.api, query(), NOW);

  assert.deepEqual(result, { ok: true, matches: [], skipped: [] });
  assert.equal(permalinkCalls(slack.calls).length, 0);
});

test("reports a permalink failure as a channel gap instead of returning an unopenable match", async () => {
  const slack = fakeSlack((method) => {
    if (method === "conversations.history") {
      return { ok: true, messages: [{ ts: "1.000001", text: "login broken" }], has_more: false };
    }
    return { ok: false, error: "message_not_found" };
  });

  const result = await searchSlackChannels(slack.api, query(), NOW);

  assert.deepEqual(result, {
    ok: true,
    matches: [],
    skipped: [{ channel: "C1", reason: "unavailable" }],
  });
});

test("skips a channel whose history request comes back as an unrecognised failure", async () => {
  const slack = fakeSlack((method, body) => {
    if (method === "conversations.history") {
      if (body.channel === "C_DOWN") {
        return {};
      }
      return { ok: true, messages: [{ ts: "1.000001", text: "login broken" }], has_more: false };
    }
    return { ok: true, permalink: "https://slack.example/p" };
  });

  const result = await searchSlackChannels(
    slack.api,
    query({ channels: ["C_DOWN", "C_OPEN"] }),
    NOW,
  );

  assert.deepEqual(found(result).skipped, [{ channel: "C_DOWN", reason: "unavailable" }]);
  assert.deepEqual(found(result).matches.map((m) => m.channel), ["C_OPEN"]);
});

test("classifies an aborted history request as a timeout skip", async () => {
  const calls: Call[] = [];
  const http = {
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      const method = url.pathname.split("/").pop()!;
      const reqBody = Object.fromEntries(url.searchParams);
      calls.push({ method, body: reqBody, httpMethod: init?.method ?? "GET" });
      if (method === "conversations.history" && reqBody.channel === "C_SLOW") {
        throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
      }
      const answer =
        method === "conversations.history"
          ? { ok: true, messages: [{ ts: "1.000001", text: "login broken" }], has_more: false }
          : { ok: true, permalink: "https://slack.example/p" };
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const api = slackApi(http, "xoxb-test");

  const result = await searchSlackChannels(api, query({ channels: ["C_SLOW", "C_OPEN"] }), NOW);

  assert.deepEqual(found(result).skipped, [{ channel: "C_SLOW", reason: "timeout" }]);
  assert.deepEqual(found(result).matches.map((m) => m.channel), ["C_OPEN"]);
});

test("stops paginating when has_more arrives with an empty next_cursor", async () => {
  const slack = fakeSlack((method) => {
    if (method === "conversations.history") {
      return {
        ok: true,
        messages: [{ ts: "1.000001", text: "login broken" }],
        has_more: true,
        response_metadata: { next_cursor: "" },
      };
    }
    return { ok: true, permalink: "https://slack.example/p" };
  });

  const result = await searchSlackChannels(slack.api, query(), NOW);

  assert.equal(historyCalls(slack.calls).length, 1);
  assert.equal(found(result).matches.length, 1);
});

test("reads are sent as GET, which is what lets ctx.http retry a transient failure", async () => {
  // Slack documents both methods as GET. Sent as POST, a 5xx or a timeout on a
  // research read was final, because the context retries only reads.
  const slack = fakeSlack((method) =>
    method === "conversations.history"
      ? { ok: true, messages: [{ ts: "1.000001", text: "login broken" }], has_more: false }
      : { ok: true, permalink: "https://slack.example/p" },
  );

  await searchSlackChannels(slack.api, query({ channels: ["C_OPEN"] }), NOW);

  assert.deepEqual(
    slack.calls.map((call) => `${call.httpMethod} ${call.method}`),
    ["GET conversations.history", "GET chat.getPermalink"],
  );
  assert.equal(slack.calls[0]!.body.channel, "C_OPEN");
});
