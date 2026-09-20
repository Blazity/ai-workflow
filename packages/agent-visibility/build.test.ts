import assert from "node:assert/strict";
import test from "node:test";
import {
  agentBriefingIndexSchema,
  agentBriefingRepositoryContextSchema,
  buildAgentBriefing,
  readVisibilityRecord,
  type AgentBriefingBuildInput,
} from "./index";
import {
  COMMENT_ONE,
  COMMENT_TWO,
  RUNTIME_TEXT,
  TICKET,
  bytes,
  noSecrets,
  planningPassInput,
  sha,
} from "./test-support/fixtures";

const textsByHash = (texts: readonly { sha256: string; text: string }[]) =>
  new Map(texts.map((entry) => [entry.sha256, entry.text]));

// Red when: the index drops or renames a field on the way through JSON, the
// schema refuses what the builder wrote, or sections lose their order.
test("a planning pass builds a record that survives JSON and parses back unchanged", async () => {
  const { index } = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });

  const read = readVisibilityRecord(agentBriefingIndexSchema, JSON.parse(JSON.stringify(index)));
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok && read.value, index);

  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(index.identity, {
    runId: "wrun_01J8ZK6Q2V",
    nodeId: "planning",
    attempt: 1,
    activationScopeId: "root",
    sequence: 2,
    kind: "agent",
    blockType: "planning_agent",
    passLabel: "expansion round 1",
    capturedAt: "2026-09-19T10:15:00.000Z",
  });
  assert.deepEqual(
    index.sections.map((section) => [section.index, section.kind, section.title]),
    [
      [0, "profile", "Harness profile: Claude default"],
      [1, "repository", "acme/web AGENTS.md"],
      [2, "memory", "acme/web facts"],
      [3, "block", "Block role and task"],
      [4, "runtime", "Runtime data"],
    ],
  );
  assert.deepEqual(index.sections[1]!.provenance, [
    { kind: "repository", id: "acme/web:AGENTS.md", version: null, hash: sha("Run pnpm test.") },
  ]);
});

// Red when: a stored text is keyed by anything but the sha256 of what is
// stored, or a size is counted in UTF-16 units instead of UTF-8 bytes.
test("each section text is stored once under the sha256 of the stored bytes, with its sizes", async () => {
  const { index, texts } = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });
  const stored = textsByHash(texts);

  const profile = index.sections[0]!;
  assert.equal(profile.sentBytes, 11);
  assert.equal(profile.storedBytes, 11);
  assert.equal(profile.sentSha256, sha("Be precise."));
  assert.equal(profile.storedSha256, sha("Be precise."));
  assert.equal(profile.truncatedForStorage, false);
  assert.equal(stored.get(profile.storedSha256), "Be precise.");

  const runtime = index.sections[4]!;
  assert.equal(runtime.storedBytes, bytes(RUNTIME_TEXT));
  assert.equal(stored.get(runtime.storedSha256), RUNTIME_TEXT);
  // Five section texts and the repository context document.
  assert.equal(texts.length, 6);
  assert.equal(stored.get(index.repositoryContext!.sha256), texts[5]!.text);
});

// Red when: part ids collide, a withheld rule disappears, or a part range is
// computed from anything but the stored bytes.
test("runtime parts keep their origins and tile the stored text in order", async () => {
  const { index } = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });
  const parts = index.sections[4]!.parts;

  assert.deepEqual(
    parts.map((part) => part.id),
    ["platform:repository_access", "platform:resolution_check", "ticket", "ticket_comment", "ticket_comment.2"],
  );
  // "Repository access protocol: request a repository by its key and wait."
  // is 69 bytes, plus the blank line that separates it from the ticket.
  const ruleEnd = 71;
  const ticketEnd = ruleEnd + bytes(`${TICKET}\n\n`);
  const commentEnd = ticketEnd + bytes(`${COMMENT_ONE}\n\n`);
  assert.deepEqual(
    parts.map((part) => [part.range.start, part.range.end]),
    [
      [0, ruleEnd],
      [ruleEnd, ruleEnd],
      [ruleEnd, ticketEnd],
      [ticketEnd, commentEnd],
      [commentEnd, commentEnd + bytes(COMMENT_TWO)],
    ],
  );
  assert.equal(commentEnd + bytes(COMMENT_TWO), bytes(RUNTIME_TEXT));
  assert.deepEqual(parts[1], {
    id: "platform:resolution_check",
    title: "Resolution check",
    origin: { kind: "platform" },
    sentBytes: 0,
    cutBeforeSend: "none",
    truncatedForStorage: "none",
    withheld: {
      reason: "pr_feedback_present",
      text: "Pull request feedback is present, so the resolution check is not sent.",
    },
    range: { start: ruleEnd, end: ruleEnd },
  });
  assert.deepEqual(parts[3]!.origin, { kind: "ticket_comment", ref: "10001", label: "Filip" });
});

// Red when: a section without explicit parts has none, so a reader cannot
// name where its text came from.
test("a section passed without parts gets one part named after its kind", async () => {
  const { index } = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });
  assert.deepEqual(index.sections[0]!.parts, [
    {
      id: "profile",
      title: "Harness profile: Claude default",
      origin: { kind: "profile" },
      sentBytes: 11,
      cutBeforeSend: "none",
      truncatedForStorage: "none",
      range: { start: 0, end: 11 },
    },
  ]);
});

// Red when: the harness extras store the script or the schema instead of
// their hashes, lose the pinned profile, or drop the profile switches that
// explain why a send carried no runtime data.
test("harness extras record hashes, skills, the pinned profile and its switches", async () => {
  const input = planningPassInput();
  const { index } = await buildAgentBriefing(input, { sanitize: noSecrets });
  assert.deepEqual(index.harness, {
    provider: "claude",
    // The send's own model, carried through unchanged, read from the input
    // rather than copied here: this package may not import the model catalog,
    // so a second literal would be a second thing to keep true.
    model: input.harness.model,
    outputSchema: { sha256: sha('{"type":"object"}') },
    skills: [{ id: "review-checklist", version: 3, sha256: null }],
    skillCount: 1,
    profile: { pinned: true, id: "builtin-claude", version: 7 },
    wrapperScriptSha256: sha(input.harness.wrapperScript!),
    includeWorkflowData: true,
    includeRepositoryInstructions: true,
  });

  const unswitched = planningPassInput();
  delete unswitched.harness.includeWorkflowData;
  delete unswitched.harness.includeRepositoryInstructions;
  const built = await buildAgentBriefing(unswitched, { sanitize: noSecrets });
  assert.equal("includeWorkflowData" in built.index.harness, false);
});

// Red when: a profile with more skills than the index lists loses the count,
// so a reader believes the list is whole.
test("skills past the listing ceiling are counted", async () => {
  const input = planningPassInput();
  input.harness.skills = Array.from({ length: 20 }, (_unused, position) => ({ id: `skill-${position}`, version: 1 }));
  const { index } = await buildAgentBriefing(input, { sanitize: noSecrets });
  assert.equal(index.harness.skills.length, 16);
  assert.equal(index.harness.skillCount, 20);
  assert.equal(index.harness.skills[15]!.id, "skill-15");
});

// Red when: the repository context is reordered, or a relationship or the
// reason for a non-usable state is dropped, or the index stops saying where
// the document is and what it holds.
test("the repository context is a stored document that keeps map order, causes, states and the work scope", async () => {
  const { index, texts } = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });
  const reference = index.repositoryContext!;
  const document = texts.find((entry) => entry.sha256 === reference.sha256)!;
  assert.equal(reference.sha256, sha(document.text));
  assert.equal(reference.bytes, bytes(document.text));
  assert.deepEqual(
    { ...reference, sha256: "", bytes: 0 },
    { sha256: "", bytes: 0, repositoryCount: 3, unlistedCount: 0, workScopeVersion: 4, leftOutCount: 1, redactionCount: 0 },
  );
  const read = readVisibilityRecord(agentBriefingRepositoryContextSchema, JSON.parse(document.text));
  const context = read.ok ? read.value : assert.fail(read.message);
  assert.deepEqual(
    context.repositories.map((repository) => [repository.key, repository.state, repository.inclusion.cause]),
    [
      ["github:acme/web", "write", "named"],
      ["github:acme/api", "read_only", "related"],
      ["github:acme/legacy", "excluded", "work_scope_entry"],
    ],
  );
  assert.deepEqual(context.repositories[1]!.inclusion, {
    cause: "related",
    via: { key: "github:acme/web", relationship: "frontend_for" },
  });
  assert.equal(context.repositories[2]!.reason, "Excluded by Filip: not part of this work.");
  assert.deepEqual(context.workScope, { version: 4, leftOutKeys: ["github:acme/legacy"] });
});

// Red when: the builder reads a clock, a random value or an unordered map.
test("building the same input twice yields byte-identical output", async () => {
  const first = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });
  const second = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

// Red when: identical texts are stored twice, which multiplies storage by the
// number of planning passes that repeat the ticket.
test("two sections with the same stored text share one stored entry", async () => {
  const input: AgentBriefingBuildInput = planningPassInput();
  input.sections[2] = { ...input.sections[2]!, text: "Be precise.", parts: undefined };
  const { index, texts } = await buildAgentBriefing(input, { sanitize: noSecrets });
  assert.equal(index.sections[0]!.storedSha256, index.sections[2]!.storedSha256);
  assert.equal(texts.length, 5);
});

// Red when: the context document carries anything that differs between
// passes (the sequence, the pass label, where the map was rendered), so six
// planning passes that saw one map store it six times.
test("six planning passes that saw the same map store its context once", async () => {
  const store = new Map<string, string>();
  const references = new Set<string>();
  for (let pass = 1; pass <= 6; pass += 1) {
    const input = planningPassInput();
    input.identity.sequence = pass;
    input.identity.passLabel = `expansion round ${pass}`;
    input.repositoryContext!.renderedAt = { sectionIndex: 4, partId: pass % 2 === 0 ? "ticket" : "platform:repository_access" };
    const { index, texts } = await buildAgentBriefing(input, { sanitize: noSecrets });
    for (const entry of texts) store.set(entry.sha256, entry.text);
    references.add(index.repositoryContext!.sha256);
    assert.equal(index.repositoryContext!.renderedAt!.partId, pass % 2 === 0 ? "ticket" : "platform:repository_access");
  }
  assert.equal(references.size, 1);
  // The five section texts are shared by every pass, and the one document.
  assert.equal(store.size, 6);
});
