// apps/dashboard/lib/agent-visibility/wording.test.ts
//
// Two mistakes this file exists to catch. One: telling a person the agent
// never got text that it did get (our storage dropped it), or the other way
// round; those are different facts and must read differently. Two: quietly
// swallowing a value this build has no words for, so a newer worker's record
// reads as if something were missing.
import assert from "node:assert/strict";
import test from "node:test";

import {
  REPOSITORY_STATES,
  USABLE_REPOSITORY_STATES,
  type AgentBriefingPart,
} from "@shared/agent-visibility";
import {
  WORK_SCOPE_ASK_REASONS,
  WORK_SCOPE_ENTRY_STATES,
  WORK_SCOPE_ORIGINS,
  WORK_SCOPE_UNAVAILABLE_REASONS,
} from "@shared/contracts";

import { buildFixtureStore, type FixtureStore } from "./test-support/fixtures";
import {
  askedBecauseLabel,
  captureLine,
  entryOriginLabel,
  entryStateLabel,
  inclusionSentence,
  runStateSentence,
  isOurs,
  missingBriefingSentence,
  nodeAbsenceSentence,
  originLabel,
  partFates,
  readingSentence,
  repositoryStateLabel,
  repositoryStateTone,
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

test("every value shipped with this build has words, and only a newer worker's is shown as a slug", () => {
  // The open vocabulary is there so a NEWER worker's value degrades to itself.
  // It is not a licence to ship a value and its screen in one commit with no
  // words: what a person then reads is "unusable" in grey where a sentence
  // belongs. This is the check that fails the day a value is added.
  for (const state of REPOSITORY_STATES) {
    assert.notEqual(repositoryStateLabel(state), state, `repository state "${state}" has no words`);
  }
  for (const origin of WORK_SCOPE_ORIGINS) {
    assert.notEqual(entryOriginLabel(origin), origin, `work scope origin "${origin}" has no words`);
  }
  for (const state of WORK_SCOPE_ENTRY_STATES) {
    assert.notEqual(entryStateLabel({ state }), state, `record state "${state}" has no words`);
  }
  for (const reason of WORK_SCOPE_UNAVAILABLE_REASONS) {
    const label = entryStateLabel({ state: "unavailable", unavailableReason: reason });
    assert.doesNotMatch(label, new RegExp(reason), `record reason "${reason}" is shown as its slug`);
  }
  for (const reason of WORK_SCOPE_ASK_REASONS) {
    assert.notEqual(askedBecauseLabel(reason), reason, `ask reason "${reason}" has no words`);
  }
  // Colour follows the package's own list of what a send may use, so a usable
  // state added there is never painted as a failure here.
  for (const state of USABLE_REPOSITORY_STATES) {
    assert.notEqual(repositoryStateTone(state), "failed", `usable state "${state}" is coloured as a failure`);
  }

  assert.equal(repositoryStateLabel("quarantined"), "quarantined");
  assert.equal(entryOriginLabel("drawn_by_a_newer_worker"), "drawn_by_a_newer_worker");
  assert.equal(repositoryStateTone("quarantined"), "neutral");
});

test("a repository with nothing to check out and one this run refused are not a person's decision", () => {
  // Both are closed doors, and neither is the Repositories page: sending an
  // operator there costs them the round it takes to find the switch already on
  // and no decision to undo.
  assert.equal(repositoryStateLabel("unusable"), "Nothing to check out");
  assert.equal(repositoryStateLabel("refused"), "Refused for this run");
  assert.notEqual(repositoryStateLabel("unusable"), repositoryStateLabel("disabled"));
  assert.notEqual(repositoryStateLabel("refused"), repositoryStateLabel("excluded"));
  assert.equal(repositoryStateTone("unusable"), "failed");
  assert.equal(repositoryStateTone("refused"), "failed");
});

test("one shut door reads the same on the map, on the record and in the question that offered it", () => {
  // These three sit within a row of each other on the ticket page. Two words
  // for one fact send a person looking for two remedies, and the one they
  // cannot act on is the one they try first.
  for (const reason of WORK_SCOPE_UNAVAILABLE_REASONS) {
    const onTheMap = repositoryStateLabel(reason);
    assert.equal(
      entryStateLabel({ state: "unavailable", unavailableReason: reason }),
      `Unavailable: ${onTheMap.toLowerCase()}`,
      `the record says something else than "${onTheMap}"`,
    );
    assert.equal(askedBecauseLabel(reason), onTheMap.toLowerCase(), `the question says something else than "${onTheMap}"`);
  }
  assert.equal(entryStateLabel({ state: "unavailable", unavailableReason: "unusable" }), "Unavailable: nothing to check out");
});

test("an entry the catalog put here says so, and does not read as a guess or as a person", () => {
  const related = entryOriginLabel("related_repository");
  assert.match(related, /catalog relates it/);
  assert.notEqual(related, entryOriginLabel("inferred"));
  assert.notEqual(related, entryOriginLabel("person"));
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


test("a block nobody ran and a block that sends nothing read as different things", () => {
  const never = nodeAbsenceSentence("never_ran");
  const silent = nodeAbsenceSentence("sends_no_prompt");
  assert.notEqual(never.title, silent.title);
  // One of them has something to do about it, and only one.
  assert.match(never.body, /Dispatch the workflow/);
  assert.doesNotMatch(silent.body, /Dispatch/);
  assert.match(silent.body, /sends no prompt/);
});

test("a reason for having no briefing that this build has no words for is quoted, not guessed", () => {
  const unknown = nodeAbsenceSentence("retired_with_the_block");
  assert.match(unknown.body, /"retired_with_the_block"/);
  assert.doesNotMatch(unknown.body, /Dispatch/);
});


test("a run that recorded every send says so quietly, and one that did not names each miss", () => {
  const whole = captureLine({ captured: 11, disabled: 0, skipped: 0, failed: 0, conflict: 0, sends: 11 });
  assert.equal(whole.whole, true);
  assert.equal(whole.text, "11 sends, all recorded");

  // The case the counters exist for: without this line a person only finds the
  // two refusals by opening the briefings that are not there.
  const partial = captureLine({ captured: 9, disabled: 0, skipped: 2, failed: 0, conflict: 0, sends: 11 });
  assert.equal(partial.whole, false);
  assert.match(partial.text, /11 sends/);
  assert.match(partial.text, /2 refused/);
});

test("a send a newer worker counted some other way is shown as a gap, not swallowed", () => {
  // `sends` is the worker's own sum, so a counter this build does not know
  // shows up as the difference and must not vanish into the recorded ones.
  const line = captureLine({ captured: 4, disabled: 0, skipped: 0, failed: 0, conflict: 0, sends: 6 });
  assert.equal(line.whole, false);
  assert.match(line.text, /2 this dashboard has no words for/);
});

test("one send is a send, not 1 sends", () => {
  assert.match(
    captureLine({ captured: 1, disabled: 0, skipped: 0, failed: 0, conflict: 0, sends: 1 }).text,
    /^1 send,/,
  );
});
