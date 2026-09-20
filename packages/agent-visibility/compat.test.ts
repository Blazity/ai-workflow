import assert from "node:assert/strict";
import test from "node:test";
import {
  REPOSITORY_STATES,
  agentBriefingIndexSchema,
  agentBriefingRepositoryContextSchema,
  agentBriefingSectionPageSchema,
  assembleClarificationRounds,
  buildAgentBriefing,
  clarificationRoundSchema,
  isKnownSlug,
  missingBriefingReasonSchema,
  readVisibilityRecord,
} from "./index";

/** The rounds alone; each test that expects skipped rows asserts them. */
const assembleRounds = (rows: Parameters<typeof assembleClarificationRounds>[0]) => {
  const assembly = assembleClarificationRounds(rows);
  assert.deepEqual(assembly.skipped, []);
  return assembly.rounds;
};
import { noSecrets, planningPassInput } from "./test-support/fixtures";

/** What a newer worker could write: values this build has no label for and
 *  fields it has never seen, in the index and in its context document. */
async function newerRecord() {
  const { index, texts } = await buildAgentBriefing(planningPassInput(), { sanitize: noSecrets });
  const json = JSON.parse(JSON.stringify(index));
  json.futureField = { anything: true };
  json.identity.kind = "transcript";
  json.harness.provider = "gemini";
  json.harness.reasoningEffort = "high";
  json.sections[4].kind = "platform_rules";
  json.sections[4].futureField = 1;
  json.sections[4].parts[2].origin.kind = "slack_thread";
  json.sections[4].parts[2].futureField = "x";
  json.sections[4].parts[3].cutBeforeSend = "partial";
  json.sections[4].parts[3].cutCause = "context_window";
  json.sections[4].parts[3].originalLengthUtf16 = 9_999;
  json.sections[4].redactions = [{ start: 0, end: 3, kind: "biometric" }];
  json.sections[4].redactionCount = 1;
  json.totals.redactions = 1;
  json.repositoryContext.futureField = true;

  const context = JSON.parse(texts.find((entry) => entry.sha256 === index.repositoryContext!.sha256)!.text);
  const repository = context.repositories[0];
  // A provider this build does not know: the write contract's closed key
  // pattern must not decide what a reader opens.
  repository.key = "bitbucket:acme/web";
  repository.state = "archived_upstream";
  repository.inclusion = { cause: "suggested_by_memory" };
  repository.rendering = "collapsed";
  repository.description.source = "readme";
  repository.relationships[0].kind = "replaces";
  repository.futureField = [1, 2];
  context.repositories[2].workScopeEntry.origin = "imported_from_linear";
  context.workScope.leftOutKeys.push("sourcehut:acme/legacy");
  return { index: json, context };
}

// Red when: a reader closes a vocabulary with an enum or `.strict()`, or reads
// keys with the write contract's closed provider list, so the first new
// state or provider a newer worker writes makes every briefing unreadable.
test("a reader opens a briefing and its context with states, causes, kinds, keys and fields it does not know", async () => {
  const record = await newerRecord();
  const read = readVisibilityRecord(agentBriefingIndexSchema, record.index);
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  const index = read.ok ? read.value : assert.fail();
  assert.equal(index.identity.kind, "transcript");
  assert.equal(index.sections[4]!.parts[2]!.origin.kind, "slack_thread");
  assert.equal(index.sections[4]!.parts[3]!.cutCause, "context_window");

  const contextRead = readVisibilityRecord(agentBriefingRepositoryContextSchema, record.context);
  assert.equal(contextRead.ok, true, contextRead.ok ? "" : contextRead.message);
  const context = contextRead.ok ? contextRead.value : assert.fail();
  const repository = context.repositories[0]!;
  // Unknown values come back as themselves, for the renderer to show.
  assert.equal(repository.key, "bitbucket:acme/web");
  assert.equal(repository.state, "archived_upstream");
  assert.equal(isKnownSlug(REPOSITORY_STATES, repository.state), false);
  assert.equal(repository.inclusion.cause, "suggested_by_memory");
});

// Red when: tolerance swallows a rule that is known: a disabled repository
// without a reason is still wrong.
test("tolerance does not excuse a known unusable state without its reason", async () => {
  const { context } = await newerRecord();
  context.repositories[0].state = "disabled";
  const read = readVisibilityRecord(agentBriefingRepositoryContextSchema, context);
  assert.equal(read.ok, false);
  assert.match(read.ok ? "" : read.message, /state "disabled" says why/);
});

// Red when: a record from a newer schema throws, or is shown as corrupt,
// instead of saying it was written by a newer version.
test("a newer schema version reads as written by a newer version, not as an error", async () => {
  const { index: json, context } = await newerRecord();
  json.schemaVersion = 2;
  const read = readVisibilityRecord(agentBriefingIndexSchema, json);
  assert.deepEqual(read.ok ? null : [read.reason, read.ok === false && "schemaVersion" in read ? read.schemaVersion : null], [
    "newer_version",
    2,
  ]);
  assert.match(read.ok ? "" : read.message, /written by a newer version of AI Workflow \(schema version 2\)/);
  const page = readVisibilityRecord(agentBriefingSectionPageSchema, {
    schemaVersion: 3,
    sectionIndex: 0,
    offset: 0,
    text: "",
    nextOffset: null,
    totalBytes: 0,
  });
  assert.equal(page.ok ? "ok" : page.reason, "newer_version");
  context.schemaVersion = 2;
  const contextRead = readVisibilityRecord(agentBriefingRepositoryContextSchema, context);
  assert.equal(contextRead.ok ? "ok" : contextRead.reason, "newer_version");
});

// Red when: a round from a newer worker with a new status, surface, author,
// reading outcome or trail event cannot be opened.
test("a reader opens rounds with statuses, surfaces and readings it does not know", () => {
  const [round] = assembleRounds({
    questions: [
      {
        clarificationId: "c1",
        runId: "r1",
        nodeId: "planning",
        questions: ["Which repository?"],
        askedAt: "2026-09-19T09:00:00.000Z",
        status: "pending",
        offered: [],
      },
    ],
    deliveries: [
      {
        clarificationId: "c1",
        words: "web",
        author: { kind: "person", display: "Filip" },
        surface: "jira",
        firstAt: "2026-09-19T09:01:00.000Z",
        reading: null,
        note: null,
      },
    ],
    trail: [],
  });
  const json = JSON.parse(JSON.stringify(round));
  json.status = "escalated";
  json.deliveries[0].surface = "slack";
  json.deliveries[0].author.kind = "bot_on_behalf";
  json.deliveries[0].reading = {
    version: 2,
    outcome: { kind: "partially_named", confidence: 0.4 },
    readBy: "ensemble",
    readAt: "2026-09-19T09:01:01.000Z",
  };
  json.effects = [{ trailId: 9, at: "2026-09-19T09:02:00.000Z", clarificationId: "c1", event: { kind: "question_escalated", to: "owner" } }];
  const read = readVisibilityRecord(clarificationRoundSchema, json);
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  // A trail event is kept whole, so a newer renderer loses nothing.
  assert.deepEqual(read.ok && read.value.effects[0]!.event, { kind: "question_escalated", to: "owner" });
});

// Red when: a new cause for a missing briefing breaks the page that explains it.
test("a reader opens a missing-briefing reason with a cause it does not know", () => {
  const read = readVisibilityRecord(missingBriefingReasonSchema, {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "capture_budget_exceeded",
    futureField: true,
  });
  assert.deepEqual(read.ok && read.value, { schemaVersion: 1, kind: "not_recorded", cause: "capture_budget_exceeded" });
});
