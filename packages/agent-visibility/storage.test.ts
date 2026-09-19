import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentBriefing, type AgentBriefingBuildInput } from "./index";
import { fakeSanitizer, noSecrets, planningPassInput, sha } from "./test-support/fixtures";

type SectionInput = AgentBriefingBuildInput["sections"][number];

function withSections(sections: SectionInput[]): AgentBriefingBuildInput {
  return { ...planningPassInput(), sections, repositoryContext: null };
}

const provenance = (kind: string) => [{ kind, id: `${kind}-source`, version: 1, hash: "h" }];

/** 100 + 100 + 100 bytes that carry provenance, 50 of block text and 300 of
 *  run data: 650 bytes in all. */
function fiveSections(runtimeParts?: SectionInput["parts"]): SectionInput[] {
  return [
    { kind: "profile", title: "Profile", provenance: provenance("profile"), text: "P".repeat(100) },
    { kind: "repository", title: "AGENTS.md", provenance: provenance("repository"), text: "R".repeat(100) },
    { kind: "memory", title: "Facts", provenance: provenance("memory"), text: "M".repeat(100) },
    { kind: "block", title: "Block", text: "B".repeat(50) },
    { kind: "runtime", title: "Runtime data", text: "T".repeat(300), parts: runtimeParts },
  ];
}

// Red when: the budget cuts run data before the sections a person can find
// again from their provenance, or wipes whichever section comes last.
test("over budget, provenance sections are cut first, evenly, and keep their identity", async () => {
  // 650 bytes against 400: 250 must go, all of it from the 300 bytes of
  // provenance sections, leaving 50 to share: 16 each (48 kept).
  const { index, texts } = await buildAgentBriefing(withSections(fiveSections()), {
    sanitize: noSecrets,
    budgetBytes: 400,
  });
  assert.deepEqual(
    index.sections.map((section) => [section.kind, section.storedBytes, section.truncatedForStorage]),
    [
      ["profile", 16, true],
      ["repository", 16, true],
      ["memory", 16, true],
      ["block", 50, false],
      ["runtime", 300, false],
    ],
  );
  const profile = index.sections[0]!;
  assert.equal(profile.sentBytes, 100);
  assert.equal(profile.redactedBytes, 100);
  assert.equal(profile.sentSha256, sha("P".repeat(100)));
  assert.equal(profile.storedSha256, sha("P".repeat(16)));
  assert.deepEqual(profile.provenance, [{ kind: "profile", id: "profile-source", version: 1, hash: "h" }]);
  assert.deepEqual(profile.parts[0]!.range, { start: 0, end: 16 });
  assert.equal(profile.parts[0]!.truncatedForStorage, "partial");
  assert.equal(profile.parts[0]!.cutBeforeSend, "none");
  assert.equal(new Map(texts.map((entry) => [entry.sha256, entry.text])).get(profile.storedSha256), "P".repeat(16));
  assert.deepEqual(index.totals, { sections: 5, sentBytes: 650, storedBytes: 398, redactions: 0, truncatedSections: 3 });
  assert.equal(index.budgetBytes, 400);
});

// Red when: run data is cut while anything else still has bytes, or a part
// past the cut is reported as kept.
test("run data is cut last, and parts say which of them storage cut", async () => {
  // 650 against 200: the provenance sections (300) and the block (50) go
  // whole, and 200 of the 300 runtime bytes stay.
  const { index } = await buildAgentBriefing(
    withSections(
      fiveSections([
        { id: "first", title: "First", origin: { kind: "ticket" }, content: "T".repeat(150) },
        { id: "second", title: "Second", origin: { kind: "ticket_comment" }, content: "T".repeat(150) },
      ]),
    ),
    { sanitize: noSecrets, budgetBytes: 200 },
  );
  assert.deepEqual(
    index.sections.map((section) => section.storedBytes),
    [0, 0, 0, 0, 200],
  );
  assert.equal(index.sections[0]!.storedSha256, sha(""));
  assert.equal(index.sections[0]!.sentSha256, sha("P".repeat(100)));
  assert.deepEqual(index.sections[0]!.parts[0]!.range, { start: 0, end: 0 });
  assert.equal(index.sections[0]!.parts[0]!.truncatedForStorage, "whole");
  assert.deepEqual(
    index.sections[4]!.parts.map((part) => [part.range.start, part.range.end, part.truncatedForStorage]),
    [
      [0, 150, "none"],
      [150, 200, "partial"],
    ],
  );
});

// Red when: text never sent is reported as a storage loss, a storage loss is
// reported as something the agent never got, or a cut loses what made it.
test("cut before send and truncated for storage are separate facts", async () => {
  const parts: SectionInput["parts"] = [
    { id: "ticket", title: "Ticket", origin: { kind: "ticket" }, content: "X".repeat(10), cut: { originalLengthUtf16: 50, cause: "section_cap" } },
    { id: "comments", title: "Comments", origin: { kind: "clarification_round" }, content: "", cut: { originalLengthUtf16: 40, cause: "clarification_budget" } },
    { id: "answer", title: "Answer", origin: { kind: "clarification_answer" }, content: "Y".repeat(90) },
  ];
  const sections: SectionInput[] = [{ kind: "runtime", title: "Runtime data", text: `${"X".repeat(10)}${"Y".repeat(90)}`, parts }];

  const roomy = await buildAgentBriefing(withSections(sections), { sanitize: noSecrets });
  const [ticket, comments, answer] = roomy.index.sections[0]!.parts;
  assert.deepEqual(
    [ticket!.cutBeforeSend, ticket!.cutCause, ticket!.originalLengthUtf16, ticket!.sentBytes, ticket!.truncatedForStorage],
    ["partial", "section_cap", 50, 10, "none"],
  );
  // The clarification budget is a loss the agent really had, told apart from
  // the section cap by its cause.
  assert.deepEqual(
    [comments!.cutBeforeSend, comments!.cutCause, comments!.originalLengthUtf16, comments!.sentBytes, comments!.truncatedForStorage],
    ["whole", "clarification_budget", 40, 0, "none"],
  );
  assert.deepEqual([answer!.cutBeforeSend, answer!.cutCause, answer!.truncatedForStorage], ["none", undefined, "none"]);
  assert.equal(roomy.index.sections[0]!.truncatedForStorage, false);

  const tight = await buildAgentBriefing(withSections(sections), { sanitize: noSecrets, budgetBytes: 40 });
  const [tightTicket, , tightAnswer] = tight.index.sections[0]!.parts;
  assert.deepEqual([tightTicket!.cutBeforeSend, tightTicket!.truncatedForStorage], ["partial", "none"]);
  assert.deepEqual([tightAnswer!.cutBeforeSend, tightAnswer!.truncatedForStorage], ["none", "partial"]);
  assert.equal(tight.index.sections[0]!.truncatedForStorage, true);
  assert.equal(tight.index.sections[0]!.storedBytes, 40);
});

// Red when: the storage cut splits a multi-byte character, leaving bytes no
// decoder can read.
test("the storage cut never splits a character", async () => {
  // Each "ą" is two bytes: a budget of 5 keeps two of them.
  const { index, texts } = await buildAgentBriefing(
    withSections([{ kind: "runtime", title: "Runtime data", text: "ą".repeat(10) }]),
    { sanitize: noSecrets, budgetBytes: 5 },
  );
  assert.equal(index.sections[0]!.storedBytes, 4);
  assert.equal(texts[0]!.text, "ąą");
});

// Red when: the storage cut lands inside a redaction marker and stores half a
// span.
test("the storage cut never lands inside a redaction marker", async () => {
  // "abc " + "[REDACTED]" + " def": the marker covers bytes 4..14, so a
  // budget of 10 moves the cut back to 4.
  const { index, texts } = await buildAgentBriefing(
    withSections([{ kind: "runtime", title: "Runtime data", text: "abc sk-live-SECRET def" }]),
    { sanitize: fakeSanitizer(), budgetBytes: 10 },
  );
  const section = index.sections[0]!;
  assert.equal(section.redactedBytes, 18);
  assert.equal(section.storedBytes, 4);
  assert.equal(texts[0]!.text, "abc ");
  assert.equal(section.redactionCount, 1);
  assert.deepEqual(section.redactions, []);
});
