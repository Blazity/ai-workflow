import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVisibilityInputError,
  agentBriefingIndexSchema,
  buildAgentBriefing,
  readVisibilityRecord,
  type AgentBriefingBuildInput,
} from "./index";
import { fakeSanitizer, noSecrets, planningPassInput, sha } from "./test-support/fixtures";

function withRuntimeParts(parts: NonNullable<AgentBriefingBuildInput["sections"][number]["parts"]>, text: string) {
  const input = planningPassInput();
  input.sections[4] = { ...input.sections[4]!, text, parts };
  return input;
}

const origin = { kind: "ticket" };

async function refusal(input: AgentBriefingBuildInput, sanitize = noSecrets): Promise<string> {
  try {
    await buildAgentBriefing(input, { sanitize });
  } catch (error) {
    assert.ok(error instanceof AgentVisibilityInputError, `expected an input error, got ${String(error)}`);
    return error.message;
  }
  assert.fail("the input was accepted");
}

// Red when: a malformed identity is stored and later joins to no attempt.
test("a malformed identity is refused with the field it is about", async () => {
  const input = planningPassInput();
  input.identity.attempt = 0;
  assert.match(await refusal(input), /identity\.attempt/);
});

// Red when: the write side accepts a briefing kind no reader was built for.
test("a briefing kind outside discovery, agent and llm is refused on write", async () => {
  const input = planningPassInput();
  (input.identity as { kind: string }).kind = "transcript";
  assert.match(await refusal(input), /identity\.kind/);
});

// Red when: a send whose compilation produced no section (a profile that
// switched everything off) is refused, which reports a prompt that was sent as
// not recorded.
test("a send with no sections is recorded with none", async () => {
  const input = planningPassInput();
  input.sections = [];
  input.repositoryContext = null;
  const { index, texts } = await buildAgentBriefing(input, { sanitize: noSecrets });
  assert.deepEqual(index.sections, []);
  assert.deepEqual(index.totals, { sections: 0, sentBytes: 0, storedBytes: 0, redactions: 0, truncatedSections: 0 });
  assert.deepEqual(texts, []);
});

// Red when: parts leave a gap, so some sent text belongs to no part.
test("parts with a gap are refused, naming the position and the part", async () => {
  const message = await refusal(
    withRuntimeParts(
      [
        { id: "ticket", title: "Ticket", origin, content: "abc" },
        { id: "comment", title: "Comment", origin, content: "ef" },
      ],
      "abcdef",
    ),
  );
  assert.match(message, /first differ at character 3 \(inside part "comment"\)/);
});

// Red when: parts overlap, so one byte is attributed to two origins.
test("overlapping parts are refused", async () => {
  const message = await refusal(
    withRuntimeParts(
      [
        { id: "ticket", title: "Ticket", origin, content: "abc" },
        { id: "comment", title: "Comment", origin, content: "cdef" },
      ],
      "abcdef",
    ),
  );
  assert.match(message, /together they are 7 characters, the text is 6/);
});

// Red when: an error message quotes the prompt, which would put a secret in a log.
test("a refusal describes positions and never quotes the text", async () => {
  const message = await refusal(
    withRuntimeParts([{ id: "ticket", title: "Ticket", origin, content: "token sk-live-SECRET" }], "token sk-live-SECRET!"),
  );
  assert.equal(message.includes("sk-live-SECRET"), false);
});

// Red when: a part the composer named and left empty is refused (the whole
// briefing lost over an empty slot) or kept looking like a part that sent
// text; or a withheld rule claims to have been sent.
test("an empty part is kept and flagged, and a withheld rule sends nothing", async () => {
  const { index } = await buildAgentBriefing(
    withRuntimeParts(
      [
        { id: "ticket", title: "Ticket", origin, content: "abc" },
        { id: "comment", title: "Comment", origin, content: "" },
      ],
      "abc",
    ),
    { sanitize: noSecrets },
  );
  const comment = index.sections[4]!.parts[1]!;
  assert.deepEqual([comment.empty, comment.sentBytes, comment.range], [true, 0, { start: 3, end: 3 }]);
  assert.equal(index.sections[4]!.parts[0]!.empty, undefined);
  assert.match(
    await refusal(
      withRuntimeParts(
        [{ id: "platform:rule", title: "Rule", origin: { kind: "platform" }, content: "abc", withheld: { reason: "not_needed", text: "Not needed." } }],
        "abc",
      ),
    ),
    /withheld, so it sends nothing/,
  );
});

// Red when: a part claims a cut that removed nothing.
test("a cut whose original length is not above what was sent is refused", async () => {
  assert.match(
    await refusal(
      withRuntimeParts([{ id: "ticket", title: "Ticket", origin, content: "abc", cut: { originalLengthUtf16: 3, cause: "section_cap" } }], "abc"),
    ),
    /says text was cut before sending, but its original length \(3 UTF-16 units\) is not above what was sent \(3\)/,
  );
});

// Red when: discovery, which runs unpinned, is recorded with profile values it
// never had.
test("discovery cannot claim a pinned harness profile, on write or on read", async () => {
  const input = planningPassInput();
  input.identity.kind = "discovery";
  assert.match(await refusal(input), /discovery send runs on the unpinned harness path/);

  input.harness.profile = null;
  const { index } = await buildAgentBriefing(input, { sanitize: noSecrets });
  assert.deepEqual(index.harness.profile, { pinned: false });

  const tampered = { ...index, harness: { ...index.harness, profile: { pinned: true, id: "builtin-claude", version: 7 } } };
  const read = readVisibilityRecord(agentBriefingIndexSchema, tampered);
  assert.equal(read.ok, false);
  assert.match(read.ok ? "" : read.message, /discovery runs on the unpinned harness path/);
});

// Red when: a reader trusts a stored part that contradicts itself (a writer
// bug or a hand-edited row): a withheld rule that sent text, a cut with no
// original size, an empty part with no reason to be empty.
test("a stored part that contradicts itself is refused on read", async () => {
  const { index } = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });
  const read = (mutate: (part: Record<string, unknown>) => void) => {
    const json = JSON.parse(JSON.stringify(index));
    mutate(json.sections[4].parts[1]);
    const result = readVisibilityRecord(agentBriefingIndexSchema, json);
    return result.ok ? "accepted" : result.message;
  };
  assert.match(read((part) => { part.sentBytes = 5; }), /withheld part sent nothing/);
  assert.match(read((part) => { delete part.withheld; }), /a part that sent nothing is withheld, cut whole, or flagged empty/);
  assert.match(
    read((part) => { part.cutBeforeSend = "whole"; delete part.withheld; part.originalLengthUtf16 = 9; }),
    /cutCause is present exactly when/,
  );
  assert.match(read((part) => { part.empty = true; }), /withheld part sent nothing, was not cut and is not flagged empty/);
  assert.match(read((part) => { part.cutBeforeSend = "partial"; }), /originalLengthUtf16 is present exactly when/);
});

// Red when: a broken sanitizer silently corrupts the stored text.
test("a sanitizer that reports a range outside the text is refused", async () => {
  const broken = () => [{ start: 5, end: 500, kind: "secret" }];
  assert.match(await refusal(planningPassInput(), broken), /unusable redaction/);
});

// Red when: an empty section is refused or invents a part.
test("a section that sent no text is recorded with no parts and zero bytes", async () => {
  const input = planningPassInput();
  input.sections[3] = { ...input.sections[3]!, text: "", parts: undefined };
  const { index } = await buildAgentBriefing(input, { sanitize: fakeSanitizer() });
  assert.equal(index.sections[3]!.sentBytes, 0);
  assert.deepEqual(index.sections[3]!.parts, []);
});

// Red when: a long description, reason or title refuses the whole briefing,
// which reports a prompt that was sent as not recorded; or the shortened text
// hides that it was shortened.
test("long free text is shortened with its full length stated, never refused", async () => {
  const input = planningPassInput();
  const context = input.repositoryContext!;
  context.repositories[0]!.description.text = "d".repeat(25_000);
  context.repositories[2]!.reason = "r".repeat(2_500);
  input.sections[0]!.title = "t".repeat(1_000);
  input.identity.passLabel = "p".repeat(500);
  const { index, texts } = await buildAgentBriefing(input, { sanitize: noSecrets });

  assert.equal(index.sections[0]!.title.length, 200);
  assert.match(index.sections[0]!.title, /^t+\u2026 \(1000 characters in full\)$/);
  assert.match(index.identity.passLabel!, /\u2026 \(500 characters in full\)$/);
  const document = JSON.parse(texts.find((entry) => entry.sha256 === index.repositoryContext!.sha256)!.text);
  const description: string = document.repositories[0].description.text;
  assert.equal(description.length, 24_000);
  assert.match(description, /^d+\u2026 \(25000 characters in full\)$/);
  const reason: string = document.repositories[2].reason;
  assert.equal(reason.length, 2_000);
  assert.match(reason, /\u2026 \(2500 characters in full\)$/);
});

// Red when: a join key the detector reports anything in is stored (a secret
// typed into a prompt name reaches storage, and MCP rewrites the key at serve
// time), or is stored redacted, which joins to nothing; or a clean key is
// withheld; or model and skill ids skip the detector.
test("a join key the detector reports is withheld with the hash of what was given, never stored", async () => {
  const input = planningPassInput();
  const promptName = "p7:deploy with sk-live-SECRET";
  input.sections[3] = {
    ...input.sections[3]!,
    provenance: [{ kind: "prompt", id: promptName, version: 2, hash: sha("body") }],
  };
  input.harness.profile = { id: "builtin-claude", version: 7 };
  input.harness.skills = [{ id: "skill-with-sk-live-SECRET", version: 1 }];
  input.harness.model = "model-sk-live-SECRET";
  const sanitize = fakeSanitizer({ "sk-live-SECRET": "configured_secret", "builtin-claude": "token" });
  const { index, texts } = await buildAgentBriefing(input, { sanitize });

  assert.deepEqual(index.sections[3]!.provenance, [
    {
      kind: "prompt",
      id: null,
      idWithheld: { reason: "redacted", lengthUtf16: promptName.length, sha256: sha(promptName) },
      version: 2,
      hash: sha("body"),
    },
  ]);
  assert.deepEqual(index.harness.profile, {
    pinned: true,
    id: null,
    idWithheld: { reason: "redacted", lengthUtf16: 14, sha256: sha("builtin-claude") },
    version: 7,
  });
  // A key the detector does not touch is stored whole.
  assert.equal(index.sections[1]!.provenance[0]!.id, "acme/web:AGENTS.md");
  assert.equal(JSON.stringify({ index, texts }).includes("sk-live-SECRET"), false);
  assert.equal(index.harness.model, "model-[REDACTED]");
  assert.equal(index.harness.skills[0]!.id, "skill-with-[REDACTED]");
  assert.equal(readVisibilityRecord(agentBriefingIndexSchema, JSON.parse(JSON.stringify(index))).ok, true);
});

// Red when: a field the sanitizer empties entirely is stored blank, so a
// title reads as missing rather than removed.
test("a field the sanitizer empties entirely reads as the marker", async () => {
  const input = planningPassInput();
  input.sections[3]!.title = "\u001B[0m";
  const stripAll = (text: string) =>
    text === "\u001B[0m" ? [{ start: 0, end: text.length, kind: "control_characters", replacement: "" }] : [];
  const { index } = await buildAgentBriefing(input, { sanitize: stripAll });
  assert.equal(index.sections[3]!.title, "[REDACTED]");
});
