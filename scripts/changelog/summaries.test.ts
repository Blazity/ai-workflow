import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  anthropicClient,
  readToneRule,
  SUMMARY_MODEL,
  summarize,
  type AreaGroup,
  type ModelClient,
} from "./summaries.ts";

const GROUPS: AreaGroup[] = [
  { area: "Dashboard", bullets: ["The Settings page shows run capacity.", "A ticket page lists repositories."] },
  { area: "MCP", bullets: ["MCP tools read the repository catalog."] },
];

const GOOD_ANSWER = JSON.stringify({
  areaSummaries: [
    { area: "Dashboard", summary: "Settings and tickets show more." },
    { area: "MCP", summary: "Clients read the catalog \u2014 directly." },
  ],
  shortVersion: [
    { area: "Dashboard", text: "Capacity sits on the Settings page." },
    { area: "MCP", text: "The catalog is readable over MCP." },
  ],
});

function collectLog(): { log: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { log: (message) => messages.push(message), messages };
}

test("the model's prose is used when it fits the release, with dashes turned into commas", async () => {
  const { log, messages } = collectLog();
  const result = await summarize({ groups: GROUPS, log, model: async () => GOOD_ANSWER, toneRule: "## Tone rule" });

  assert.equal(result.generatedBy, "model");
  assert.deepEqual(result.shortVersion.map((paragraph) => paragraph.area), ["Dashboard", "MCP"]);
  assert.equal(result.areaSummaries.get("MCP"), "Clients read the catalog, directly.");
  assert.deepEqual(messages, []);
});

const FAILURES: Array<[string, ModelClient, RegExp]> = [
  ["a missing key", anthropicClient(undefined), /ANTHROPIC_API_KEY is not set/u],
  ["a failed call", async () => { throw new Error("the Anthropic API answered HTTP 529: overloaded"); }, /HTTP 529/u],
  ["an answer that is not JSON", async () => "Here are your notes!", /JSON/u],
  [
    "an answer naming an area the release does not have",
    async () => GOOD_ANSWER.replace('"area":"MCP","summary"', '"area":"Billing","summary"'),
    /Billing/u,
  ],
  [
    "an answer leaving an area without a summary",
    async () => JSON.stringify({ ...JSON.parse(GOOD_ANSWER), areaSummaries: [{ area: "Dashboard", summary: "x" }] }),
    /left out a summary for MCP/u,
  ],
  [
    "a short version with five paragraphs",
    async () =>
      JSON.stringify({
        ...JSON.parse(GOOD_ANSWER),
        shortVersion: ["Dashboard", "MCP", "Dashboard", "MCP", "Dashboard"].map((area) => ({ area, text: "t" })),
      }),
    /twice|paragraphs/u,
  ],
];

for (const [name, model, reason] of FAILURES) {
  test(`${name} still yields a release: plain lines per area, no short version, and the reason logged`, async () => {
    const { log, messages } = collectLog();
    const result = await summarize({ groups: GROUPS, log, model, toneRule: "## Tone rule" });

    assert.equal(result.generatedBy, "fallback");
    assert.deepEqual(result.shortVersion, []);
    assert.equal(result.areaSummaries.get("Dashboard"), "Two changes in this area.");
    assert.equal(result.areaSummaries.get("MCP"), "One change in this area.");
    assert.match(result.reason ?? "", reason);
    assert.equal(messages.length, 1);
    assert.match(messages[0], reason);
  });
}

test("the call names the model, asks for JSON, disables thinking and sends no sampling parameters", async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent = { init, url };
    return new Response(JSON.stringify({ content: [{ text: GOOD_ANSWER, type: "text" }], stop_reason: "end_turn" }));
  }) as unknown as typeof fetch;

  const text = await anthropicClient("sk-test", fakeFetch)({ schema: { type: "object" }, system: "s", user: "u" });

  assert.equal(text, GOOD_ANSWER);
  assert.equal(sent?.url, "https://api.anthropic.com/v1/messages");
  const headers = sent?.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(String(sent?.init.body));
  assert.equal(body.model, SUMMARY_MODEL);
  assert.deepEqual(body.output_config, { format: { schema: { type: "object" }, type: "json_schema" } });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal("temperature" in body, false);
});

test("a truncated or refused answer counts as a failed call", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ text: "{", type: "text" }], stop_reason: "max_tokens" }))) as unknown as typeof fetch;
  await assert.rejects(anthropicClient("sk-test", fakeFetch)({ schema: {}, system: "s", user: "u" }), /max_tokens/u);
});

test("the prompt quotes the tone rule from changelog/README.md, its one home", async () => {
  const rule = await readToneRule(resolve(import.meta.dirname, "../.."));
  assert.match(rule, /^## Tone rule/u);
  assert.match(rule, /Never name a\s+defect/u);
  assert.doesNotMatch(rule, /## Releases/u);
});
