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
import { ConnectionValueError, type IntegrationContext } from "@integrations/sdk";
import { manifest } from "./manifest";
import { runtime } from "./worker";

type Call = { method: string; body: Record<string, string> };

/**
 * A Slack that answers each Web API method from `answer`: a body it sends
 * with 200 (which is how Slack says almost everything), a `Response` of its
 * own, or a throw for a request that never got an answer.
 */
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
        const method = new URL(String(input)).pathname.split("/").pop()!;
        calls.push({
          method,
          body: Object.fromEntries(new URLSearchParams(String(init?.body))),
        });
        const answered = answer(method);
        if (answered instanceof Response) return answered;
        return new Response(JSON.stringify(answered), {
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
  assert.match(result.message!, /could not be deleted: Slack could not answer \(ratelimited\)\./);
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

/**
 * What an admin reads after pressing Test, and what the card does next.
 *
 * `{ ok: false }` makes the card Failing and stops every run that posts to
 * Slack; a throw is filed as Slack being unreachable and leaves the card as it
 * was. Slack documents `internal_error`, `fatal_error`, `service_unavailable`,
 * `request_timeout`, `ratelimited` and `team_added_to_org` as its own trouble,
 * and answers a rate limit with HTTP 429. The test used to read every one of
 * those, and a delivery check that timed out, as a refused token or channel.
 */
// Red when: Test reads as a pure read while it schedules a message in the
// channel and deletes it (QA): the admin is told what it did.
test("a passing test says a message was scheduled and deleted, as the check's description does", async () => {
  const { ctx } = contextWith((method) =>
    method === "auth.test"
      ? { ok: true, team: "Blazity" }
      : method === "chat.scheduleMessage"
        ? { ok: true, scheduled_message_id: "Q1" }
        : { ok: true },
  );
  const result = await runtime.testConnection(ctx);
  assert.equal(result.ok, true);
  assert.match(String(result.ok && result.message), /a message was scheduled there and deleted before it was sent/);
  const description = manifest.health.find((check) => check.id === "channel")?.description ?? "";
  assert.match(description, /^Schedules a message in the configured channel and deletes it before it is sent/);
});

test("a token Slack refuses fails the connection test, naming Slack's reason", async () => {
  const { ctx } = contextWith(() => ({ ok: false, error: "invalid_auth" }));

  assert.deepEqual(await runtime.testConnection(ctx), {
    ok: false,
    reason: "Slack refused the bot token (invalid_auth).",
  });
});

test("a channel the bot was never invited to fails the connection test", async () => {
  const { ctx } = contextWith((method) =>
    method === "auth.test" ? { ok: true, team: "Blazity" } : { ok: false, error: "not_in_channel" },
  );

  const result = await runtime.testConnection(ctx);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not_in_channel/u);
});

for (const error of ["internal_error", "fatal_error", "service_unavailable", "ratelimited"]) {
  test(`Slack's own ${error} on auth.test is no verdict, and throws`, async () => {
    const { ctx } = contextWith(() => ({ ok: false, error }));

    await assert.rejects(runtime.testConnection(ctx), new RegExp(error));
  });
}

test("a delivery check Slack did not answer in time is no verdict, and throws", async () => {
  const { ctx } = contextWith((method) => {
    if (method === "auth.test") return { ok: true, team: "Blazity" };
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  await assert.rejects(runtime.testConnection(ctx), /did not answer in time/u);
});

test("an HTTP 429 or 5xx from Slack is no verdict, whatever its body says", async () => {
  for (const status of [429, 503]) {
    const { ctx } = contextWith(
      () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status,
          headers: { "content-type": "application/json", "retry-after": "1" },
        }),
    );
    await assert.rejects(runtime.testConnection(ctx), /Slack did not answer/u, String(status));
  }
});

test("the health rows say Slack did not answer rather than blaming the token or channel", async () => {
  const { ctx } = contextWith(() => ({ ok: false, error: "service_unavailable" }));

  const token = await botAuth()(ctx);
  assert.equal(token.status, "down");
  assert.match(token.message!, /Slack did not answer, so the token could not be checked/u);

  const delivery = await channel()(ctx);
  assert.equal(delivery.status, "down");
  assert.match(delivery.message!, /Slack did not answer, so delivery could not be checked/u);
});

test("a cause that ends its own sentence is not given a second full stop", async () => {
  const { ctx } = contextWith(() => {
    throw new Error("The connection was reset by the peer.");
  });

  await assert.rejects(runtime.testConnection(ctx), {
    message: "Slack did not answer: The connection was reset by the peer.",
  });
  assert.equal(
    (await botAuth()(ctx)).message,
    "Slack did not answer, so the token could not be checked: The connection was reset by the peer.",
  );
});

test("a token core would not send is a verdict about the token, not Slack being silent", async () => {
  // What `ctx.http` throws for a token no header can carry, before anything
  // is sent: a curly quote pasted with it, here.
  const refusal =
    "The Bot token has a character in it that no request header can carry, usually a curly quote or an invisible character pasted from a document.";
  const { ctx } = contextWith(() => {
    throw new ConnectionValueError("botToken", refusal);
  });

  assert.deepEqual(await runtime.testConnection(ctx), {
    ok: false,
    reason: refusal,
    malformed: true,
  });
  assert.deepEqual(await botAuth()(ctx), { status: "down", message: refusal });
  assert.deepEqual(await channel()(ctx), {
    status: "down",
    message: `The bot cannot deliver to the configured channel: ${refusal}`,
  });
});
