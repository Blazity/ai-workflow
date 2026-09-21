/**
 * The slash command, from the bytes Slack sends to the answer a person reads.
 *
 * The payload below is a Slack slash command body with Slack's documented
 * field set, url-encoded exactly as Slack sends it, and the signature over it
 * was computed OUTSIDE this repository, with:
 *
 *   printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r
 *
 * That matters: a "recorded payload" whose signature came from the same
 * function that verifies it proves only that the function agrees with itself.
 * This one proves we implement the algorithm Slack documents. What it does not
 * prove is that Slack's own signer agrees, which only a request from Slack can
 * show; that is what the on-production check of this stage is for.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IntegrationWebhookRequest, RunControlOutcome } from "@integrations/sdk";
import { deliverSlashCommandOutcome, receiveSlashCommand } from "./slash-command";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TIMESTAMP = "1758326400";
const SIGNATURE = "v0=d879cea9a27e6b31cbad62dc36bb74a55bb588d76f3b89d3b3f274841f355491";
const BODY =
  "token=gIkuvaNzQIHg97ATvDxqgjtO&team_id=T0001&team_domain=blazity" +
  "&channel_id=C2147483705&channel_name=ai-workflow&user_id=U2147483697&user_name=filip" +
  "&command=%2Fai-workflow&text=cancel+AWT-42&api_app_id=A0MDYCDME&is_enterprise_install=false" +
  "&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT0001%2F1234567890%2FabcdefghijklmnopqrstuvwX" +
  "&trigger_id=13345224609.738474920.8088930838d88f008e0";

/** Slack's five-minute replay window is measured against the clock. */
function atSigningTime<T>(run: () => T): T {
  const realNow = Date.now;
  Date.now = () => Number(TIMESTAMP) * 1000;
  try {
    return run();
  } finally {
    Date.now = realNow;
  }
}

function request(overrides: Partial<IntegrationWebhookRequest> = {}): IntegrationWebhookRequest {
  return {
    method: "POST",
    rawBody: BODY,
    headers: {
      "x-slack-signature": SIGNATURE,
      "x-slack-request-timestamp": TIMESTAMP,
      "content-type": "application/x-www-form-urlencoded",
    },
    query: {},
    ...overrides,
  };
}

const config = { signingSecret: SIGNING_SECRET, allowedUserIds: undefined };

test("a signed slash command becomes the run control command it asked for", async () => {
  const reception = await atSigningTime(() => receiveSlashCommand(request(), config));
  assert.equal(reception.kind, "run_control");
  if (reception.kind !== "run_control") return;
  assert.deepEqual(reception.command, {
    kind: "cancel",
    ticketKey: "AWT-42",
    actor: "U2147483697",
  });
  // The acknowledgement Slack has about three seconds to receive.
  assert.equal(reception.response.status, 200);
  assert.deepEqual(reception.response.body, {
    response_type: "ephemeral",
    text: "Working on `/ai-workflow cancel AWT-42`...",
  });
  // Where the answer goes, opaque to core.
  assert.deepEqual(reception.deliverTo, {
    responseUrl:
      "https://hooks.slack.com/commands/T0001/1234567890/abcdefghijklmnopqrstuvwX",
  });
});

test("one changed byte of the body is refused, because the signature covers it", async () => {
  const tampered = request({ rawBody: BODY.replace("cancel+AWT-42", "cancel+AWT-43") });
  const reception = await atSigningTime(() => receiveSlashCommand(tampered, config));
  assert.equal(reception.kind, "refused");
  if (reception.kind !== "refused") return;
  assert.equal(reception.status, 401);
});

test("a signature from five minutes ago is refused rather than replayed", async () => {
  // The signature itself is valid; only the clock has moved. Verified against
  // the real clock, which is six minutes past the signed timestamp and more.
  const reception = await receiveSlashCommand(request(), config);
  assert.equal(reception.kind, "refused");
  if (reception.kind !== "refused") return;
  assert.equal(reception.status, 401);
});

test("a deployment with no signing secret answers 503, not 401 and not 500", async () => {
  // Nothing is wrong with the request: this deployment was never given what it
  // needs to read one, and an admin reading 401 would go looking at Slack.
  const reception = await receiveSlashCommand(request(), {
    signingSecret: undefined,
    allowedUserIds: undefined,
  });
  assert.equal(reception.kind, "refused");
  if (reception.kind !== "refused") return;
  assert.equal(reception.status, 503);
});

test("an empty allowlist means everyone, and separators alone are still empty", async () => {
  // SETUP.md has promised this since the command existed. Reading " , , " as
  // "nobody" would lock a whole workspace out of its own runs.
  for (const allowedUserIds of [undefined, "", " , , "]) {
    const reception = await atSigningTime(() =>
      receiveSlashCommand(request(), { signingSecret: SIGNING_SECRET, allowedUserIds }),
    );
    assert.equal(reception.kind, "run_control", `allowlist ${JSON.stringify(allowedUserIds)}`);
  }
});

test("an allowlist that does not name the caller refuses, and says so only to them", async () => {
  const reception = await atSigningTime(() =>
    receiveSlashCommand(request(), {
      signingSecret: SIGNING_SECRET,
      allowedUserIds: "U000000001, U000000002",
    }),
  );
  assert.equal(reception.kind, "answered");
  if (reception.kind !== "answered") return;
  assert.deepEqual(reception.response.body, {
    response_type: "ephemeral",
    text: "Not authorized.",
  });
});

test("the allowlist ignores the spaces somebody typed around the ids", async () => {
  const reception = await atSigningTime(() =>
    receiveSlashCommand(request(), {
      signingSecret: SIGNING_SECRET,
      allowedUserIds: " U000000001 , U2147483697 ",
    }),
  );
  assert.equal(reception.kind, "run_control");
});

test("every command the help text offers comes out the other side", async () => {
  const commands: [string, unknown][] = [
    ["list", { kind: "list" }],
    ["status AWT-42", { kind: "status", ticketKey: "AWT-42" }],
    ["redis summary", { kind: "summary" }],
    ["redis inspect AWT-42", { kind: "inspect", ticketKey: "AWT-42" }],
    ["redis reset AWT-42", { kind: "reset", ticketKey: "AWT-42" }],
  ];
  for (const [text, expected] of commands) {
    const body = BODY.replace("text=cancel+AWT-42", `text=${encodeURIComponent(text)}`);
    const signed = await signed_request(body);
    const reception = await atSigningTime(() => receiveSlashCommand(signed, config));
    assert.equal(reception.kind, "run_control", text);
    if (reception.kind !== "run_control") continue;
    assert.deepEqual(reception.command, expected, text);
  }
});

test("help and an unknown command are answered here and never reach core", async () => {
  for (const text of ["", "help", "wat"]) {
    const signed = await signed_request(
      BODY.replace("text=cancel+AWT-42", `text=${encodeURIComponent(text)}`),
    );
    const reception = await atSigningTime(() => receiveSlashCommand(signed, config));
    assert.equal(reception.kind, "answered", text);
    if (reception.kind !== "answered") continue;
    const body = reception.response.body as { text: string; response_type: string };
    assert.equal(body.response_type, "ephemeral");
    assert.match(body.text, /ai-workflow commands/);
    if (text === "wat") assert.match(body.text, /^Unknown command\./);
  }
});

test("a command whose work failed is answered, not left at \"Working on ...\"", async () => {
  // The defect this replaces: the deferred handler logged the error and the
  // person watched an acknowledgement that never turned into anything.
  const posted: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const outcome: RunControlOutcome = { kind: "failed", message: "the database refused" };
    await deliverSlashCommandOutcome(
      { responseUrl: "https://hooks.slack.com/commands/T0001/1/abc" },
      outcome,
      { warn: () => {} },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.url, "https://hooks.slack.com/commands/T0001/1/abc");
  assert.deepEqual(posted[0]!.body, {
    response_type: "in_channel",
    text: ":warning: That command failed: the database refused",
  });
});

/** The same independent signature, for a body this test varied. */
async function signed_request(body: string): Promise<IntegrationWebhookRequest> {
  const { createHmac } = await import("node:crypto");
  const digest = createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${TIMESTAMP}:${body}`)
    .digest("hex");
  return request({ rawBody: body, headers: {
    "x-slack-signature": `v0=${digest}`,
    "x-slack-request-timestamp": TIMESTAMP,
    "content-type": "application/x-www-form-urlencoded",
  } });
}
