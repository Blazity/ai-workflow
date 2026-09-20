// apps/dashboard/lib/agent-visibility/edit.test.ts
//
// The person these sentences are for is not an engineer, is often on a phone,
// and has just been told that something did not work. The mistakes that matter
// here: telling them a status code, telling them nothing changed when nobody
// can know that, offering an undo that does not put back what was there, and
// describing what was asked for instead of what the record now says.
import assert from "node:assert/strict";
import test from "node:test";

import {
  actionsFor,
  appliedSentence,
  editFailureNotice,
  movedWhileDeciding,
  offeredNotInRecord,
  readEditFailure,
  undoOf,
  undoSentence,
  willHappenSentence,
  type EditIntent,
  type RecordEntry,
} from "./edit";

const WEB = "github:acme/shop-web";
const API = "github:acme/shop-api";

function entry(state: string, over: Partial<RecordEntry> = {}): RecordEntry {
  return {
    repositoryKey: WEB,
    state,
    origin: "person",
    rationale: "named in the answer",
    decidedBy: { kind: "person", actorId: "usr_filip", actorLabel: "Filip Maszota" },
    decidedAt: "2026-09-18T09:20:04.000Z",
    ...over,
  } as RecordEntry;
}

function intentOf(action: EditIntent["action"], before: RecordEntry | null): EditIntent {
  return { repositoryKey: WEB, action, before, version: 4 };
}

test("an action is never offered as a change to the state an entry already has", () => {
  assert.deepEqual(actionsFor(entry("selected")), ["exclude", "remove"]);
  assert.deepEqual(actionsFor(entry("excluded")), ["select", "remove"]);
  // Only a run records `unavailable`, and a person may still decide either way.
  assert.deepEqual(actionsFor(entry("unavailable", { unavailableReason: "not_enabled" })), [
    "select",
    "exclude",
    "remove",
  ]);
  // Nothing to remove yet. Both ways of deciding are offered: a question that
  // offered three repositories to somebody who meant one leaves two they want
  // ruled out, and exclude is what keeps a later question from offering them.
  assert.deepEqual(actionsFor(null), ["select", "exclude"]);
});

test("a change says what it will do to the work, not which endpoint it calls", () => {
  assert.match(willHappenSentence(intentOf("exclude", entry("selected"))), /work will not touch/);
  assert.match(willHappenSentence(intentOf("exclude", entry("selected"))), /will not offer it again/);
  assert.match(willHappenSentence(intentOf("select", null)), /may touch/);
  assert.match(willHappenSentence(intentOf("remove", entry("excluded"))), /as if nobody had decided about it/);
  for (const action of ["select", "exclude", "remove"] as const) {
    assert.ok(willHappenSentence(intentOf(action, null)).includes(WEB), "the repository is named");
  }
});

test("what happened is read from the record that came back, never from what was asked for", () => {
  // A `remove` of an entry somebody else removed first is applied and changes
  // nothing. "Removed" would be a sentence about the request.
  assert.equal(appliedSentence(WEB, null), `${WEB} is not in the record.`);
  const after = entry("excluded", { decidedAt: "2026-09-19T09:00:00.000Z", rationale: "" });
  const sentence = appliedSentence(WEB, after);
  assert.match(sentence, /is now: excluded/);
  assert.match(sentence, /Filip Maszota/);
  assert.match(sentence, /19 Sept 2026/);
});

test("an undo goes back to the state that was there, not to the opposite of what was done", () => {
  const selectedFromNothing = intentOf("select", null);
  assert.equal(undoOf(selectedFromNothing, entry("selected"), 5)?.action, "remove");
  const excludedWhatWasSelected = intentOf("exclude", entry("selected"));
  assert.equal(undoOf(excludedWhatWasSelected, entry("excluded"), 5)?.action, "select");
  const selectedWhatWasExcluded = intentOf("select", entry("excluded"));
  assert.equal(undoOf(selectedWhatWasExcluded, entry("selected"), 5)?.action, "exclude");
  // The version an undo is decided against is the one the change produced, so
  // a third writer in between refuses it like any other stale write.
  assert.equal(undoOf(selectedFromNothing, entry("selected"), 5)?.version, 5);
});

test("what only a run can record is not offered as an undo", () => {
  const unavailable = entry("unavailable", { unavailableReason: "not_enabled", origin: "trigger_policy" });
  assert.equal(undoOf(intentOf("select", unavailable), entry("selected"), 5), null);
});

test("an undo is said as putting the record back, and never hides whose name it carries", () => {
  assert.match(undoSentence(intentOf("select", null)), /goes back to not being in the record/);
  const back = undoSentence(intentOf("exclude", entry("selected")));
  assert.match(back, /goes back to selected/);
  assert.match(back, /Your name goes on it/);
});

test("a refusal for lack of permission reads as a sentence, and the bare status word is not repeated", () => {
  // What `requireDashboardActor` answers a non-member with.
  const failure = readEditFailure({ status: 403, error: { statusMessage: "Forbidden" }, errorMessage: "Forbidden" });
  assert.deepEqual(failure, { kind: "forbidden", message: null });
  const notice = editFailureNotice(failure, 4);
  assert.match(notice.body, /Nothing was changed/);
  assert.match(notice.body, /every member of the workspace/);
  assert.match(notice.body, /an owner or an admin/i);
  assert.doesNotMatch(notice.body, /Forbidden|403/);
  assert.equal(notice.action, "none");
});

test("a session that has ended says so and offers the way back", () => {
  const notice = editFailureNotice(readEditFailure({ status: 401, error: null, errorMessage: "Unauthorized" }), 4);
  assert.equal(notice.action, "signin");
  assert.match(notice.body, /Nothing was changed/);
  assert.doesNotMatch(notice.body, /Unauthorized|401/);
});

test("the worker's own refusal is passed on whole when it is a sentence", () => {
  const said =
    "The repository catalog does not enable github:acme/old-admin, so the whole edit was refused. Ask an owner or an admin to enable it on the Repositories page, or send the edit again without it.";
  const failure = readEditFailure({ status: 400, error: { statusMessage: said }, errorMessage: said });
  assert.deepEqual(failure, { kind: "refused", message: said });
  assert.equal(editFailureNotice(failure, 4).body, `Nothing was changed. ${said}`);
});

test("a stale version says both versions and that nothing was written", () => {
  const failure = readEditFailure({
    status: 409,
    error: { error: "version_conflict", latestVersion: 7 },
    errorMessage: "version_conflict",
  });
  assert.deepEqual(failure, { kind: "conflict", latestVersion: 7 });
  const notice = editFailureNotice(failure, 4);
  assert.match(notice.body, /Nothing was changed/);
  assert.match(notice.body, /version 4/);
  assert.match(notice.body, /version 7/);
  assert.equal(notice.action, "reload");
  // The machine word for it is not a sentence anybody can act on.
  assert.doesNotMatch(notice.body, /version_conflict/);
});

test("an answer that never arrived never claims the change was not made", () => {
  for (const failure of [
    readEditFailure({ status: 503, error: null, errorMessage: "upstream is down" }),
    readEditFailure({ status: 504, error: null, errorMessage: "Worker request timed out" }),
  ]) {
    const notice = editFailureNotice(failure, 4);
    assert.match(notice.body, /cannot be told from here/);
    assert.match(notice.body, /Read the record again/);
    assert.doesNotMatch(notice.body, /Nothing was changed/);
    assert.equal(notice.action, "reload");
  }
});

test("a worker too old to take edits is told apart from one that refused", () => {
  const notice = editFailureNotice(readEditFailure({ status: 404, error: null, errorMessage: "Not found" }), 4);
  assert.match(notice.body, /Nothing was changed/);
  assert.match(notice.body, /deploy separately/);
  assert.doesNotMatch(notice.body, /Not found|404/);
});

test("a repository a question offered and nobody decided about is offered to select", () => {
  const rounds = [
    { question: { offered: [{ key: WEB }, { key: API }] } },
    { question: { offered: [{ key: API }] } },
    { question: { offered: null } },
  ];
  assert.deepEqual(offeredNotInRecord(rounds, [{ repositoryKey: WEB }]), [API]);
  assert.deepEqual(offeredNotInRecord(rounds, [{ repositoryKey: WEB }, { repositoryKey: API }]), []);
  assert.deepEqual(offeredNotInRecord([], []), []);
});

test("a record that moved under an open confirmation says nothing was sent", () => {
  const moved = movedWhileDeciding(4, 5);
  assert.match(moved.body, /Nothing was sent/);
  assert.match(moved.body, /version 5/);
  assert.match(moved.body, /version 4/);
});
