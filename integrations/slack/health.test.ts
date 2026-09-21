/**
 * The two checks an admin reads on System health, and what they do to somebody
 * else's channel.
 *
 * The delivery check is the one with consequences: it proves the bot can post
 * by scheduling a message far in the future and deleting it before it can
 * arrive. A check that leaves that message behind has put a note into a real
 * channel, so "verified" may only be said over a message that is gone.
 *
 * These assertions came from `apps/worker/src/services/system/probes.test.ts`
 * with the probe itself, against the same recorded Slack answers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IntegrationContext } from "@integrations/sdk";
import { manifest } from "./manifest";
import { runtime } from "./worker";

type Call = { method: string; body: Record<string, string> };

function contextWith(answer: (method: string) => unknown): {
  ctx: IntegrationContext<typeof manifest>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const ctx = {
    connection: { botToken: "xoxb-test", channelId: "C1" },
    signal: new AbortController().signal,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: {
      async fetch(input: string | URL | Request, init?: RequestInit) {
        const method = String(input).split("/").pop()!;
        calls.push({
          method,
          body: Object.fromEntries(new URLSearchParams(String(init?.body))),
        });
        return new Response(JSON.stringify(answer(method)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  } as unknown as IntegrationContext<typeof manifest>;
  return { ctx, calls };
}

const channel = () => runtime.health.channel!;
const botAuth = () => runtime.health["bot-auth"]!;

test("the delivery check schedules a message and deletes the one it scheduled", async () => {
  const { ctx, calls } = contextWith((method) =>
    method === "chat.scheduleMessage"
      ? { ok: true, scheduled_message_id: "Q0123" }
      : { ok: true },
  );

  const result = await channel()(ctx);

  assert.equal(result.status, "live");
  const deletion = calls.find((call) => call.method === "chat.deleteScheduledMessage");
  assert.equal(deletion?.body.scheduled_message_id, "Q0123");
  assert.equal(deletion?.body.channel, "C1");
  // Far enough out that a leaked probe is obvious in the queue rather than
  // arriving in the channel next week.
  const scheduled = calls.find((call) => call.method === "chat.scheduleMessage");
  const days = (Number(scheduled!.body.post_at) * 1000 - Date.now()) / 86_400_000;
  assert.ok(days > 50, `${days} days ahead`);
});

test("a channel the bot cannot post to is down, with Slack's own reason", async () => {
  const { ctx } = contextWith(() => ({ ok: false, error: "channel_not_found" }));

  const result = await channel()(ctx);

  assert.equal(result.status, "down");
  assert.match(result.message!, /channel_not_found/);
});

test("a probe message that could not be deleted is said out loud, with its date", async () => {
  // The failure that matters to the person whose channel it is: the check
  // passed, and in sixty days a message nobody asked for arrives.
  const { ctx, calls } = contextWith((method) =>
    method === "chat.scheduleMessage"
      ? { ok: true, scheduled_message_id: "Q0123" }
      : { ok: false, error: "ratelimited" },
  );

  const result = await channel()(ctx);

  assert.equal(result.status, "degraded");
  assert.match(result.message!, /could not be deleted: Slack refused the message \(ratelimited\)\./);
  assert.match(result.message!, /It will post in the channel on \d{4}-\d{2}-\d{2}/);
  // A delete that failed once is usually a rate limit, so it is retried.
  assert.equal(calls.filter((call) => call.method === "chat.deleteScheduledMessage").length, 3);
});

test("a message Slack scheduled without naming it cannot be deleted, and says so", async () => {
  const { ctx, calls } = contextWith(() => ({ ok: true }));

  const result = await channel()(ctx);

  assert.equal(result.status, "degraded");
  assert.match(result.message!, /did not name the probe message/);
  assert.equal(calls.filter((call) => call.method === "chat.deleteScheduledMessage").length, 0);
});

test("a message already gone counts as cleaned up, not as a leak", async () => {
  // Two overlapping scans race here, and the second one deleting nothing is
  // the normal outcome rather than a warning for an admin to act on.
  const { ctx } = contextWith((method) =>
    method === "chat.scheduleMessage"
      ? { ok: true, scheduled_message_id: "Q0123" }
      : { ok: false, error: "invalid_scheduled_message_id" },
  );

  assert.equal((await channel()(ctx)).status, "live");
});

test("the token check names the workspace, and names the refusal when it fails", async () => {
  const good = contextWith(() => ({ ok: true, team: "Blazity" }));
  const good_result = await botAuth()(good.ctx);
  assert.equal(good_result.status, "live");
  assert.match(good_result.message!, /Blazity/);

  const bad = contextWith(() => ({ ok: false, error: "invalid_auth" }));
  const bad_result = await botAuth()(bad.ctx);
  assert.equal(bad_result.status, "down");
  assert.match(bad_result.message!, /invalid_auth/);
});
