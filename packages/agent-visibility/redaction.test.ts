import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVisibilityInputError,
  DEFAULT_REDACTION_REPLACEMENT,
  agentBriefingIndexSchema,
  buildAgentBriefing,
  readVisibilityRecord,
  type AgentBriefingBuildInput,
} from "./index";
import { bytes, fakeSanitizer, noSecrets, planningPassInput, sha } from "./test-support/fixtures";

type SectionInput = AgentBriefingBuildInput["sections"][number];

function runtimeOnly(section: SectionInput): AgentBriefingBuildInput {
  return { ...planningPassInput(), sections: [section], repositoryContext: null };
}

const storedBytes = (text: string, start: number, end: number) =>
  Buffer.from(text, "utf8").subarray(start, end).toString("utf8");

/**
 * The Bearer rule of the MCP serve-time sanitizer, copied from
 * `apps/worker/src/mcp/sanitize-result.ts` (BEARER_CREDENTIAL and its
 * replacement), which rewrites every string MCP serves.
 */
const mcpBearerRule = (text: string) =>
  text.replace(/(Authorization\s*:\s*Bearer\s+)[^\s"'\\]+/giu, (_match, prefix: string) => `${prefix}[REDACTED]`);

// Red when: the default marker carries the kind (`[REDACTED:token]`): after
// "Authorization: Bearer " MCP rewrites it at serve time, every byte after it
// moves, and the dashboard and MCP show different text for one briefing.
test("the default marker is [REDACTED], which MCP serves unchanged, and the kind travels in the span", async () => {
  assert.equal(DEFAULT_REDACTION_REPLACEMENT, "[REDACTED]");
  const { index, texts } = await buildAgentBriefing(
    runtimeOnly({ kind: "runtime", title: "Runtime data", text: "curl -H 'Authorization: Bearer sk-live-SECRET' api" }),
    { sanitize: fakeSanitizer({ "sk-live-SECRET": "token" }) },
  );
  const stored = texts[0]!.text;
  assert.equal(stored, "curl -H 'Authorization: Bearer [REDACTED]' api");
  assert.equal(mcpBearerRule(stored), stored);
  assert.deepEqual(index.sections[0]!.redactions, [{ start: 31, end: 41, kind: "token" }]);
});

// Red when: a replacement MCP would strip (a control character) is written
// into the stored text, which again makes serving change the bytes.
test("a replacement with control characters is refused", async () => {
  const sanitize = (text: string) =>
    text.includes("sk-live-SECRET")
      ? [{ start: text.indexOf("sk-live-SECRET"), end: text.indexOf("sk-live-SECRET") + 14, kind: "token", replacement: "\u001B[31m[gone]" }]
      : [];
  await assert.rejects(
    buildAgentBriefing(runtimeOnly({ kind: "runtime", title: "Runtime data", text: "key sk-live-SECRET" }), { sanitize }),
    (error: unknown) => error instanceof AgentVisibilityInputError && /without control characters/.test(error.message),
  );
});

// Red when: a part range or a span is computed from the sent text instead of
// the stored one, so after a redaction every later range points at the wrong
// bytes.
test("a secret removed from the middle of a part keeps spans and part ranges on the stored bytes", async () => {
  const sentMiddle = "key sk-live-SECRET here ";
  const { index, texts } = await buildAgentBriefing(
    runtimeOnly({
      kind: "runtime",
      title: "Runtime data",
      text: `hello ${sentMiddle}bye`,
      parts: [
        { id: "greeting", title: "Greeting", origin: { kind: "ticket" }, content: "hello " },
        { id: "middle", title: "Middle", origin: { kind: "ticket_comment" }, content: sentMiddle },
        { id: "farewell", title: "Farewell", origin: { kind: "ticket_comment" }, content: "bye" },
      ],
    }),
    { sanitize: fakeSanitizer() },
  );
  const section = index.sections[0]!;
  const stored = texts[0]!.text;
  assert.equal(stored, "hello key [REDACTED] here bye");
  // Sent: 6 + 24 + 3. Stored: the 14-byte secret became a 10-byte marker.
  assert.equal(section.sentBytes, 33);
  assert.equal(section.redactedBytes, 29);
  assert.equal(section.storedBytes, 29);
  assert.equal(section.sentSha256, sha(`hello ${sentMiddle}bye`));
  assert.equal(section.storedSha256, sha(stored));
  assert.deepEqual(section.redactions, [{ start: 10, end: 20, kind: "secret" }]);
  assert.equal(storedBytes(stored, 10, 20), "[REDACTED]");
  assert.deepEqual(
    section.parts.map((part) => [part.id, part.sentBytes, part.range.start, part.range.end]),
    [
      ["greeting", 6, 0, 6],
      ["middle", 24, 6, 26],
      ["farewell", 3, 26, 29],
    ],
  );
  assert.equal(storedBytes(stored, 26, 29), "bye");
});

// Red when: the sanitizer is run part by part, so a secret the composer
// happened to split between two parts is stored in two harmless-looking
// halves.
test("a secret split across two parts is still redacted, its marker where it began", async () => {
  const { index, texts } = await buildAgentBriefing(
    runtimeOnly({
      kind: "runtime",
      title: "Runtime data",
      text: "key sk-live-SECRET here",
      parts: [
        { id: "first", title: "First", origin: { kind: "ci_log" }, content: "key sk-live-SE" },
        { id: "second", title: "Second", origin: { kind: "ci_log" }, content: "CRET here" },
      ],
    }),
    { sanitize: fakeSanitizer() },
  );
  const stored = texts[0]!.text;
  assert.equal(stored, "key [REDACTED] here");
  assert.equal(stored.includes("sk-live-SE"), false);
  assert.equal(stored.includes("CRET"), false);
  const section = index.sections[0]!;
  assert.deepEqual(
    section.parts.map((part) => [part.id, part.sentBytes, part.range.start, part.range.end]),
    [
      ["first", 14, 0, 14],
      ["second", 9, 14, 19],
    ],
  );
  // The marker sits in the first part; the second part lost its first four
  // bytes, marked by a zero-width span where they were.
  assert.deepEqual(section.redactions, [
    { start: 4, end: 14, kind: "secret" },
    { start: 14, end: 14, kind: "secret" },
  ]);
  assert.equal(readVisibilityRecord(agentBriefingIndexSchema, JSON.parse(JSON.stringify(index))).ok, true);
});

// Red when: the builder finds redactions by looking for markers in the text,
// so a person who writes a marker in a comment gets a span.
test("a literal redaction marker written by a person is text, not a redaction", async () => {
  const text = "they pasted [REDACTED] and [REDACTED:secret] here";
  const { index, texts } = await buildAgentBriefing(
    runtimeOnly({ kind: "runtime", title: "Runtime data", text }),
    { sanitize: fakeSanitizer() },
  );
  assert.deepEqual(index.sections[0]!.redactions, []);
  assert.equal(index.sections[0]!.redactionCount, 0);
  assert.equal(texts[0]!.text, text);
});

// Red when: a title, label, pass label, description, rule or reason reaches
// the stored record without passing the sanitizer, or its redaction is not
// counted where a reader looks for it.
test("a secret in any free-text field is redacted, counted and never stored", async () => {
  const input = planningPassInput();
  const secret = "sk-live-SECRET";
  input.identity.passLabel = `retry with ${secret}`;
  input.sections[0]!.title = `Profile ${secret}`;
  input.sections[4]!.parts![2]!.title = `Ticket ${secret}`;
  input.sections[4]!.parts![3]!.origin = { kind: "ticket_comment", ref: secret, label: `Filip ${secret}` };
  input.sections[4]!.parts![1]!.withheld = { reason: "pr_feedback_present", text: `withheld ${secret}` };
  const context = input.repositoryContext!;
  context.repositories[0]!.description.text = `Storefront ${secret}`;
  context.repositories[0]!.rules = `Rules ${secret}`;
  context.repositories[2]!.reason = `Excluded ${secret}`;

  const { index, texts } = await buildAgentBriefing(input, { sanitize: fakeSanitizer() });
  const everything = JSON.stringify({ index, texts });
  assert.equal(everything.includes(secret), false);
  assert.equal(index.identity.passLabel, "retry with [REDACTED]");
  assert.equal(index.sections[0]!.title, "Profile [REDACTED]");
  // The origin label is often a person's name: it passes like every other field.
  assert.equal(index.sections[4]!.parts[3]!.origin.label, "Filip [REDACTED]");
  // passLabel, the profile section's title and the title of its implicit part
  // (which repeats it), a part title, ref, label and withheld text: seven
  // fields of the index outside section text.
  assert.equal(index.metadataRedactions, 7);
  assert.equal(index.sections[0]!.parts[0]!.title, "Profile [REDACTED]");
  // The description, rules and reason live in the context document.
  assert.equal(index.repositoryContext!.redactionCount, 3);
  const document = JSON.parse(texts.find((entry) => entry.sha256 === index.repositoryContext!.sha256)!.text);
  assert.equal(document.repositories[0].description.text, "Storefront [REDACTED]");
});

// Red when: two detectors that both match one token produce two overlapping
// spans, which a page cannot mark.
test("overlapping reports from the sanitizer become one span", async () => {
  const { index, texts } = await buildAgentBriefing(
    runtimeOnly({ kind: "runtime", title: "Runtime data", text: "a sk-live-SECRET b" }),
    { sanitize: fakeSanitizer({ "sk-live-SECRET": "token", SECRET: "configured_secret" }) },
  );
  assert.equal(texts[0]!.text, "a [REDACTED] b");
  assert.deepEqual(index.sections[0]!.redactions, [{ start: 2, end: 12, kind: "token" }]);
});

// Red when: every stripped control character is stored as a span of its own,
// so a CI trace with thousands of ANSI codes bloats the index; or the strip
// leaves no trace at all.
test("stripped control characters are counted per part, not listed", async () => {
  const escape = "\u001B";
  const strip = (text: string) => {
    const found = [];
    for (let at = text.indexOf(escape); at >= 0; at = text.indexOf(escape, at + 1)) {
      found.push({ start: at, end: at + 1, kind: "control_characters", replacement: "" });
    }
    return found;
  };
  const log = `red${escape}[0m green${escape}[32m`.repeat(500);
  const { index, texts } = await buildAgentBriefing(
    runtimeOnly({
      kind: "runtime",
      title: "Runtime data",
      text: `ticket${log}`,
      parts: [
        { id: "ticket", title: "Ticket", origin: { kind: "ticket" }, content: "ticket" },
        { id: "ci_log", title: "CI log", origin: { kind: "ci_log" }, content: log },
      ],
    }),
    { sanitize: strip },
  );
  const section = index.sections[0]!;
  assert.equal(texts[0]!.text, `ticket${"red[0m green[32m".repeat(500)}`);
  assert.deepEqual(section.redactions, []);
  assert.equal(section.redactionCount, 0);
  assert.equal(section.parts[0]!.controlCharactersStripped, undefined);
  assert.equal(section.parts[1]!.controlCharactersStripped, 1_000);
});

// Red when: a ticket with a few hundred email addresses loses spans (its
// plain `[REDACTED]` markers then cannot be told from text a person typed),
// or a list past the ceiling claims to be complete.
test("a section lists every span up to 2,048 and says whether the list is complete", async () => {
  const section = async (count: number) => {
    const text = "mail anna@acme.test; ".repeat(count);
    const { index } = await buildAgentBriefing(runtimeOnly({ kind: "runtime", title: "Runtime data", text }), {
      sanitize: fakeSanitizer({ "anna@acme.test": "email" }),
    });
    return index.sections[0]!;
  };
  const ticket = await section(300);
  assert.equal(ticket.redactions.length, 300);
  assert.equal(ticket.redactionCount, 300);
  assert.equal(ticket.redactionListComplete, true);
  assert.deepEqual(ticket.redactions[299], { start: 299 * 17 + 5, end: 299 * 17 + 15, kind: "email" });

  const trace = await section(2_100);
  assert.equal(trace.redactions.length, 2_048);
  assert.equal(trace.redactionCount, 2_100);
  assert.equal(trace.redactionListComplete, false);
});

// Red when: span lists that together pass the index bound make the builder
// refuse the briefing (a sent prompt reported as not recorded), or store an
// index over its bound, or keep claiming complete lists.
test("span lists give way to the index bound, marked incomplete, and the send is still recorded", async () => {
  const text = "key sk-live-SECRET; ".repeat(2_100);
  const input: AgentBriefingBuildInput = {
    ...planningPassInput(),
    repositoryContext: null,
    sections: Array.from({ length: 8 }, () => ({ kind: "runtime", title: "CI log", text })),
  };
  const { index } = await buildAgentBriefing(input, { sanitize: fakeSanitizer(), budgetBytes: 4 * 1024 * 1024 });
  assert.ok(bytes(JSON.stringify(index)) <= 512 * 1024, `the index is ${bytes(JSON.stringify(index))} bytes`);
  for (const stored of index.sections) {
    assert.equal(stored.redactionCount, 2_100);
    assert.equal(stored.redactionListComplete, false);
    assert.ok(stored.redactions.length > 0 && stored.redactions.length < 2_048);
  }
  assert.equal(readVisibilityRecord(agentBriefingIndexSchema, JSON.parse(JSON.stringify(index))).ok, true);
});

// Red when: a lone surrogate left by the compiler's cut is stored, or sized as
// anything but the U+FFFD the model received.
test("a lone surrogate is stored and sized as U+FFFD", async () => {
  const { index, texts } = await buildAgentBriefing(
    runtimeOnly({ kind: "runtime", title: "Runtime data", text: "ab\uD83D" }),
    { sanitize: noSecrets },
  );
  assert.equal(texts[0]!.text, "ab\uFFFD");
  assert.equal(index.sections[0]!.sentBytes, bytes("ab\uFFFD"));
  assert.equal(index.sections[0]!.sentBytes, 5);
  assert.equal(index.sections[0]!.sentSha256, sha("ab\uFFFD"));
});
