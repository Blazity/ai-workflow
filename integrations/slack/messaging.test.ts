/**
 * What a run's notification does to a channel, against recorded Slack Web API
 * answers.
 *
 * The bodies below are the shapes `chat.postMessage`, `chat.update` and
 * `chat.postMessage` with `thread_ts` return, including the two failures that
 * drive every recovery path: `thread_not_found` (the message we anchored on is
 * gone) and `not_in_channel` (the bot was never invited). Slack answers 200
 * with `{ ok: false, error }` for both, which is the thing a caller reading
 * only the HTTP status gets wrong.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { MessagingConversation, MessagingTicket } from "@integrations/sdk";
import { slackApi } from "./api";
import { slackMessaging } from "./messaging";

const TICKET: MessagingTicket = {
  key: "AWT-42",
  url: "https://acme.atlassian.net/browse/AWT-42",
};

const RECORDED_WEB_API = JSON.parse(
  readFileSync(new URL("./fixtures/web-api-responses.json", import.meta.url), "utf8"),
) as {
  chatPostMessageSuccess: Record<string, unknown>;
  chatUpdateSuccess: Record<string, unknown>;
};

interface Call {
  method: string;
  body: Record<string, string>;
}

/** A Slack that answers from a script, and records what it was asked. */
function fakeSlack(answers: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const remaining = new Map(Object.entries(answers).map(([k, v]) => [k, [...v]]));
  const http = {
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const method = String(input).split("/").pop()!;
      calls.push({
        method,
        body: Object.fromEntries(new URLSearchParams(String(init?.body))),
      });
      const queue = remaining.get(method);
      const answer = queue?.shift() ?? { ok: false, error: "unexpected_call" };
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { calls, api: slackApi(http, "xoxb-test") };
}

function conversation(handle: string | null) {
  const record: { remembered: string | null; forgotten: boolean } = {
    remembered: null,
    forgotten: false,
  };
  const value: MessagingConversation = {
    handle,
    async remember(next) {
      record.remembered = next;
    },
    async forget() {
      record.forgotten = true;
    },
  };
  return { value, record };
}

const silent = { info: () => {}, warn: () => {} };

test("recorded Web API responses anchor a thread and hand core the handle", async () => {
  const slack = fakeSlack({
    "chat.postMessage": [
      structuredClone(RECORDED_WEB_API.chatPostMessageSuccess),
      structuredClone(RECORDED_WEB_API.chatPostMessageSuccess),
    ],
  });
  const conv = conversation(null);
  const messaging = slackMessaging({ api: slack.api, channelId: "C1", log: silent });

  const delivery = await messaging.notifyForTicket(TICKET, { kind: "started" }, conv.value);

  assert.deepEqual(delivery, { delivered: true });
  assert.equal(conv.record.remembered, "1503435956.000247");
  // A status line at the top of the channel, and the detail under it.
  assert.equal(slack.calls.length, 2);
  assert.equal(slack.calls[0]!.body.thread_ts, undefined);
  assert.match(slack.calls[0]!.body.text!, /STATUS: in progress/);
  assert.equal(slack.calls[1]!.body.thread_ts, "1503435956.000247");
  assert.match(slack.calls[1]!.body.text!, /Task <.*AWT-42.*> started/);
});

test("a later event edits the status line in place and replies under it", async () => {
  const slack = fakeSlack({
    "chat.update": [structuredClone(RECORDED_WEB_API.chatUpdateSuccess)],
    "chat.postMessage": [{ ok: true, ts: "1758300000.000300" }],
  });
  const conv = conversation("1758300000.000100");
  const messaging = slackMessaging({ api: slack.api, channelId: "C1", log: silent });

  const delivery = await messaging.notifyForTicket(
    TICKET,
    { kind: "failed", phase: "research", reason: "the agent ran out of budget" },
    conv.value,
  );

  assert.deepEqual(delivery, { delivered: true });
  // Nothing was re-anchored: the thread a ticket owns outlives its events.
  assert.equal(conv.record.remembered, null);
  assert.equal(slack.calls[0]!.method, "chat.update");
  assert.equal(slack.calls[0]!.body.ts, "1758300000.000100");
  assert.equal(slack.calls[1]!.body.thread_ts, "1758300000.000100");
});

test("a note never touches the status line", async () => {
  // A mid-run message that overwrote "PR ready" would leave the channel
  // showing the wrong state for the rest of the run.
  const slack = fakeSlack({ "chat.postMessage": [{ ok: true, ts: "1758300000.000400" }] });
  const conv = conversation("1758300000.000100");
  const messaging = slackMessaging({ api: slack.api, channelId: "C1", log: silent });

  const delivery = await messaging.notifyForTicket(
    TICKET,
    { kind: "note", text: "deploying now" },
    conv.value,
  );

  assert.deepEqual(delivery, { delivered: true });
  assert.deepEqual(
    slack.calls.map((call) => call.method),
    ["chat.postMessage"],
  );
  assert.equal(slack.calls[0]!.body.thread_ts, "1758300000.000100");
  assert.equal(slack.calls[0]!.body.text, "deploying now");
});

test("a deleted status message is forgotten and the thread starts again", async () => {
  const slack = fakeSlack({
    "chat.update": [{ ok: false, error: "message_not_found" }],
    "chat.postMessage": [
      { ok: true, ts: "1758300000.000500" },
      { ok: true, ts: "1758300000.000600" },
    ],
  });
  const conv = conversation("1758300000.000100");
  const messaging = slackMessaging({ api: slack.api, channelId: "C1", log: silent });

  const delivery = await messaging.notifyForTicket(TICKET, { kind: "started" }, conv.value);

  assert.deepEqual(delivery, { delivered: true });
  assert.equal(conv.record.forgotten, true);
  assert.equal(conv.record.remembered, "1758300000.000500");
});

test("a deleted status message is anchored again by any event that is not a note", async () => {
  // The rule the port states: with no usable handle, every event but a note
  // posts a new status line and hands core its handle. A run that fails after
  // somebody deleted the status message must still leave a thread to find.
  const slack = fakeSlack({
    "chat.update": [{ ok: false, error: "message_not_found" }],
    "chat.postMessage": [
      { ok: true, ts: "1758300000.000700" },
      { ok: true, ts: "1758300000.000800" },
    ],
  });
  const conv = conversation("1758300000.000100");
  const messaging = slackMessaging({ api: slack.api, channelId: "C1", log: silent });

  const delivery = await messaging.notifyForTicket(
    TICKET,
    { kind: "failed", phase: "research", reason: "the agent ran out of budget" },
    conv.value,
  );

  assert.deepEqual(delivery, { delivered: true });
  assert.equal(conv.record.forgotten, true);
  assert.equal(conv.record.remembered, "1758300000.000700");
  assert.deepEqual(
    slack.calls.map((call) => [call.method, call.body.thread_ts]),
    [
      ["chat.update", undefined],
      ["chat.postMessage", undefined],
      ["chat.postMessage", "1758300000.000700"],
    ],
  );
  assert.match(slack.calls[1]!.body.text!, /STATUS: failed/i);
});

test("a channel the bot was never invited to is reported, not swallowed", async () => {
  // Slack answers 200 with ok:false here. The block that asked has to be able
  // to say `skipped` and why, rather than reporting a message nobody received.
  const slack = fakeSlack({
    "chat.postMessage": [
      { ok: false, error: "not_in_channel" },
      { ok: false, error: "not_in_channel" },
    ],
  });
  const conv = conversation(null);
  const messaging = slackMessaging({ api: slack.api, channelId: "C1", log: silent });

  const delivery = await messaging.notifyForTicket(
    TICKET,
    { kind: "note", text: "deploying now" },
    conv.value,
  );

  assert.deepEqual(delivery, {
    delivered: false,
    reason: "Slack refused the channel (not_in_channel); invite the bot to it",
  });
});

test("a Slack that never answered reports the outage rather than a bad token", async () => {
  const http = {
    async fetch(): Promise<Response> {
      throw Object.assign(new Error("terminated"), { name: "TimeoutError" });
    },
  };
  const conv = conversation("1758300000.000100");
  const messaging = slackMessaging({
    api: slackApi(http, "xoxb-test"),
    channelId: "C1",
    log: silent,
  });

  const delivery = await messaging.notifyForTicket(
    TICKET,
    { kind: "note", text: "deploying now" },
    conv.value,
  );

  assert.deepEqual(delivery, { delivered: false, reason: "Slack did not answer in time" });
});

/**
 * `delivered` is whether the event's message went out, as the port defines it,
 * and the status line is logged when it could not be updated. It used to mean
 * two things: a status post Slack refused made the delivery `false` although
 * the message was in the channel, while a status edit that was rate limited
 * made it `true` for the same half-updated thread.
 */
function recordingLog() {
  const warnings: { event: string; fields: Record<string, unknown> }[] = [];
  return {
    warnings,
    log: {
      info: () => {},
      warn: (fields: Record<string, unknown>, event: string) => warnings.push({ event, fields }),
    },
  };
}

test("a status line Slack would not post leaves the message delivered, and says so in the log", async () => {
  const slack = fakeSlack({
    "chat.postMessage": [{ ok: false, error: "msg_too_long" }, { ok: true, ts: "1758300000.000700" }],
  });
  const audit = recordingLog();
  const messaging = slackMessaging({ api: slack.api, channelId: "C1", log: audit.log });

  const delivery = await messaging.notifyForTicket(TICKET, { kind: "started" }, conversation(null).value);

  assert.deepEqual(delivery, { delivered: true });
  // The detail went top-level, so the event still left its record.
  assert.equal(slack.calls[1]!.body.thread_ts, undefined);
  assert.deepEqual(
    audit.warnings.map((warning) => [warning.event, warning.fields.reason]),
    [["slack_status_line_failed", "Slack refused the message (msg_too_long)"]],
  );
});

test("a status line Slack would not edit leaves the message delivered, and says so in the log", async () => {
  const slack = fakeSlack({
    "chat.update": [{ ok: false, error: "ratelimited" }],
    "chat.postMessage": [{ ok: true, ts: "1758300000.000800" }],
  });
  const audit = recordingLog();
  const messaging = slackMessaging({ api: slack.api, channelId: "C1", log: audit.log });

  const delivery = await messaging.notifyForTicket(
    TICKET,
    { kind: "started" },
    conversation("1758300000.000100").value,
  );

  assert.deepEqual(delivery, { delivered: true });
  assert.equal(slack.calls[1]!.body.thread_ts, "1758300000.000100");
  assert.deepEqual(
    audit.warnings.map((warning) => warning.event),
    ["slack_status_line_failed"],
  );
});
