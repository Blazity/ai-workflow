/**
 * The connection test and the health probe, against Mem0 answering with the
 * bodies its documentation shows (and, for statuses it does not document,
 * with the bare status).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FAKE_KEY, mem0Answering, recorded, undocumented } from "./test-support";
import { runtime } from "./worker";

test("a key Mem0 refuses says the key is wrong, not that Mem0 is unreachable", async () => {
  // Mistake it catches: reading ping's documented 401 as "no verdict", which
  // tells the admin to wait for an outage that is not happening.
  const { ctx, sent } = mem0Answering(() => recorded("ping-unauthorized.json", 401));
  const verdict = await runtime.testConnection(ctx);
  assert.deepEqual(verdict, { ok: false, reason: "Mem0 refused this API key (401)." });
  assert.equal(sent[0]?.url.href, "https://api.mem0.ai/v1/ping/");
  assert.equal(sent[0]?.headers.get("authorization"), `Token ${FAKE_KEY}`);
});

test("a self-hosted server's key is named as one and never sent to the hosted platform", async () => {
  // Mistake: sending an m0sk_ key to api.mem0.ai, which answers a bare 401.
  const { ctx, sent } = mem0Answering(() => recorded("ping-unauthorized.json", 401), { apiKey: "m0sk_abc123" });
  const verdict = await runtime.testConnection(ctx);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.reason, /self-hosted Mem0 server/u);
  assert.equal(sent.length, 0);
});

test("a key pasted with a line break is malformed, and the sentence quotes none of it", async () => {
  const { ctx, sent } = mem0Answering(() => recorded("ping-ok.json"), { apiKey: "m0-abc\ndef" });
  const verdict = await runtime.testConnection(ctx);
  assert.equal(verdict.ok === false && verdict.malformed, true);
  assert.doesNotMatch(verdict.ok ? "" : verdict.reason, /abc|def/u);
  assert.equal(sent.length, 0);
});

for (const [name, answer] of [
  ["a rate limit", () => undocumented.rateLimited("3600")],
  ["a 503", undocumented.unavailable],
  ["an HTML 502 page", undocumented.gatewayPage],
] as const) {
  test(`${name} while an admin presses Test throws, so a working connection stays Connected`, async () => {
    // Mistake: returning { ok: false }, which core files as credential_rejected.
    const { ctx } = mem0Answering(answer);
    await assert.rejects(runtime.testConnection(ctx));
  });
}

test("a 200 that is not Mem0's answer throws rather than passing", async () => {
  const { ctx } = mem0Answering(() => new Response("<html>captive portal</html>", { status: 200 }));
  await assert.rejects(runtime.testConnection(ctx), /did not answer the way the Mem0 API does/u);
});

test("a pass names the organization and project the key writes into", async () => {
  // Mistake: a bare "Connected", so a valid key for the wrong project shows nowhere.
  const { ctx } = mem0Answering(() => recorded("ping-ok.json"));
  const verdict = await runtime.testConnection(ctx);
  assert.equal(verdict.ok, true);
  assert.match(verdict.ok ? (verdict.message ?? "") : "", /organization org-example-1, project proj-example-1/u);
});

test("a pass that cannot tell the project says so", async () => {
  const { ctx } = mem0Answering(() => recorded("ping-status-only.json"));
  const verdict = await runtime.testConnection(ctx);
  assert.equal(verdict.ok, true);
  assert.match(verdict.ok ? (verdict.message ?? "") : "", /did not say which organization and project/u);
});

test("the health probe tells a refused key from Mem0 not answering", async () => {
  const refused = await runtime.health.api(mem0Answering(() => recorded("ping-unauthorized.json", 401)).ctx);
  assert.deepEqual(refused, { status: "down", message: "Mem0 refused the API key (401)." });
  const busy = await runtime.health.api(mem0Answering(() => undocumented.unavailable()).ctx);
  assert.equal(busy.status, "down");
  assert.match(busy.message ?? "", /did not answer/u);
  const live = await runtime.health.api(mem0Answering(() => recorded("ping-status-only.json")).ctx);
  assert.deepEqual(live, { status: "live" });
});
