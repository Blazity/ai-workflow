// apps/dashboard/lib/agent-visibility/wording.test.ts
//
// Two mistakes this file exists to catch. One: telling a person the agent
// never got text that it did get (our storage dropped it), or the other way
// round; those are different facts and must read differently. Two: quietly
// swallowing a value this build has no words for, so a newer worker's record
// reads as if something were missing.
import assert from "node:assert/strict";
import test from "node:test";

import type { AgentBriefingPart } from "@shared/agent-visibility";

import { buildFixtureStore, type FixtureStore } from "./test-support/fixtures";
import {
  inclusionSentence,
  runStateSentence,
  isOurs,
  missingBriefingSentence,
  originLabel,
  partFates,
  readingSentence,
  sendTitle,
} from "./wording";

let store: FixtureStore;
test.before(async () => {
  store = await buildFixtureStore();
});

function part(briefingId: string, sectionIndex: number, partId: string): AgentBriefingPart {
  const found = store.briefings.get(briefingId)!.sections[sectionIndex]!.parts.find((entry) => entry.id === partId);
  assert.ok(found, `no part ${partId}`);
  return found;
}

test("what the cap cut and what storage trimmed never read the same", () => {
  const cut = partFates(part("brf_plan_4", 4, "ci-checks"));
  const trimmed = partFates(part("brf_plan_4", 1, "repository"));

  assert.deepEqual(
    cut.map((fate) => fate.label),
    ["Cut before sending"],
  );
  assert.equal(cut[0]!.tone, "lost");
  assert.match(cut[0]!.sentence, /the agent got only the text shown here/i);
  assert.match(cut[0]!.sentence, /200,000 character section cap/);

  assert.deepEqual(
    trimmed.map((fate) => fate.label),
    ["Trimmed for storage"],
  );
  assert.equal(trimmed[0]!.tone, "kept");
  assert.match(trimmed[0]!.sentence, /The agent got all of this part/);
});

test("a part cut whole says the agent never got it, with its old size", () => {
  const [fate, ...rest] = partFates(part("brf_plan_4", 4, "clarification:1"));
  assert.deepEqual(rest, []);
  assert.equal(fate!.tone, "lost");
  assert.match(fate!.sentence, /Removed whole by the 16,000 character budget for clarification answers/);
  assert.match(fate!.sentence, /The agent never got this part \(18,400 characters\)/);
});

test("a rule left out on purpose says so, in the worker's own words", () => {
  const [fate] = partFates(part("brf_plan_2", 4, "resolution-check"));
  assert.equal(fate!.tone, "deliberate");
  assert.equal(fate!.label, "Withheld on purpose");
  assert.match(fate!.sentence, /the pull request carries review feedback/);
  assert.match(fate!.sentence, /the already-resolved exit is not offered/);
});

test("a cut cause this build has no words for is shown as itself", () => {
  const invented: AgentBriefingPart = {
    ...part("brf_plan_4", 4, "ci-checks"),
    cutCause: "quota_of_the_month",
  };
  assert.match(partFates(invented)[0]!.sentence, /Shortened by "quota_of_the_month"/);
});

test("an empty slot is told as empty, not as a loss", () => {
  const empty: AgentBriefingPart = {
    ...part("brf_plan_2", 4, "resolution-check"),
    withheld: undefined,
    empty: true,
  };
  const [fate, ...rest] = partFates(empty);
  assert.deepEqual(rest, []);
  assert.equal(fate!.tone, "empty");
  assert.equal(fate!.label, "Empty");
});

test("a part that was sent and kept whole carries no fate at all", () => {
  assert.deepEqual(partFates(part("brf_plan_2", 4, "ticket")), []);
});

test("origins name the person, and an origin kind we do not know is shown as itself", () => {
  const comment = originLabel(part("brf_plan_2", 4, "comment:2").origin);
  assert.equal(comment.kind, "Ticket comment");
  assert.equal(comment.detail, "by Anna Kowalska");

  const answer = originLabel(part("brf_plan_2", 4, "clarification:2").origin);
  assert.equal(answer.kind, "Clarification answer");
  assert.equal(answer.detail, "round 2, by Filip Maszota");

  const invented = originLabel({ kind: "slack_thread", ref: "C123" } as never);
  assert.equal(invented.kind, "slack_thread");
  assert.equal(invented.detail, "C123");
});

test("our own rules are the only parts marked as ours", () => {
  assert.equal(isOurs(part("brf_plan_2", 4, "repository-access-protocol").origin), true);
  assert.equal(isOurs(part("brf_plan_2", 4, "ticket").origin), false);
  assert.equal(isOurs(part("brf_plan_2", 4, "comment:1").origin), false);
});

test("every way a briefing can be missing says which one it is", () => {
  const waiting = missingBriefingSentence({ schemaVersion: 1, kind: "not_sent_yet" });
  assert.equal(waiting.tone, "waiting");
  assert.match(waiting.body, /still preparing its prompt/);

  const never = missingBriefingSentence({
    schemaVersion: 1,
    kind: "never_sent",
    attemptState: "failed",
    runStatus: "failed",
    failure: { category: "sandbox", message: "The sandbox stopped responding." },
  });
  assert.equal(never.tone, "lost");
  assert.match(never.body, /failed before its prompt went out, so the agent got nothing/);
  assert.equal(never.failure, "sandbox: The sandbox stopped responding.");

  const disabled = missingBriefingSentence({ schemaVersion: 1, kind: "not_recorded", cause: "capture_disabled" });
  assert.equal(disabled.tone, "not_kept");
  assert.match(disabled.body, /switched off when this attempt ran/);

  const expired = missingBriefingSentence({ schemaVersion: 1, kind: "expired" });
  assert.match(expired.body, /removed together with the run's replay/);
});

test("a cause from a newer worker is quoted, never read as one we know", () => {
  const unknown = missingBriefingSentence({ schemaVersion: 1, kind: "not_recorded", cause: "sampled_out" });
  assert.match(unknown.body, /recorded the cause "sampled_out"/);
  assert.match(unknown.body, /no words for yet/);
});

test("a send is titled by its pass, so three passes are not three identical rows", () => {
  assert.equal(sendTitle({ kind: "discovery" }), "Repository discovery");
  assert.equal(sendTitle({ kind: "agent" }), "Agent pass");
  assert.equal(sendTitle({ kind: "agent", passLabel: "expansion closed" }), "Agent pass: expansion closed");
  assert.equal(sendTitle({ kind: "tool_loop" }), "tool_loop");
});

test("an answer read as something this build does not know is shown as read", () => {
  assert.equal(
    readingSentence({ version: 1, outcome: { kind: "postponed" }, readBy: "model", readAt: "2026-09-18T09:00:00.000Z" }),
    'Read as "postponed".',
  );
  assert.equal(
    readingSentence({
      version: 1,
      outcome: { kind: "repositories", repositoryKeys: ["github:acme/shop-web"], repositoryKeyCount: 3 },
      readBy: "model",
      readAt: "2026-09-18T09:00:00.000Z",
    }),
    "Chose github:acme/shop-web and 2 more.",
  );
});

test("being in the catalog says nothing about being enabled", () => {
  // A disabled or archived repository is listed too, and the line sits right
  // under "Disabled in the catalog by an administrator".
  assert.equal(inclusionSentence({ cause: "catalog" }), "It is listed in the catalog.");
  assert.doesNotMatch(inclusionSentence({ cause: "catalog" }), /enabled/);
  assert.equal(inclusionSentence({ cause: "named" }), "The ticket or event names it.");
  assert.match(inclusionSentence({ cause: "invented_by_a_newer_worker" }), /"invented_by_a_newer_worker"/);
});

test("a run with nothing left says which nothing it is", () => {
  // "No briefings" has four meanings, and only one of them is a loss.
  assert.equal(runStateSentence("available"), null);
  assert.match(runStateSentence("expired")!.body, /removed when its retention ran out/);
  assert.match(runStateSentence("replay_gone")!.body, /no longer held/);
  assert.match(runStateSentence("predates_capture")!.body, /before AI Workflow recorded what agents are sent/);
  assert.notEqual(runStateSentence("expired")!.body, runStateSentence("replay_gone")!.body);

  const invented = runStateSentence("quarantined")!;
  assert.match(invented.body, /recorded the state "quarantined"/);
  assert.match(invented.body, /no words for yet/);
});
