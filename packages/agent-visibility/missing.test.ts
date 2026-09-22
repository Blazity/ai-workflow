import assert from "node:assert/strict";
import test from "node:test";
import {
  explainMissingBriefing,
  missingBriefingReasonSchema,
  readVisibilityRecord,
  type MissingBriefingFacts,
} from "./index";

/** A live attempt on a live run whose code captures, with capture on, nothing
 *  sent and nothing captured yet: every test changes some facts from here. */
const live: MissingBriefingFacts = {
  attemptState: "running",
  runStatus: "running",
  failure: null,
  promptSent: false,
  captureCapable: true,
  captureDisabled: false,
  capturedKinds: [],
  replayExpired: false,
  sendsEveryAttempt: true,
  runLostASend: false,
};

const explain = (change: Partial<MissingBriefingFacts>) => explainMissingBriefing({ ...live, ...change });
const preparing = { category: "sandbox", message: "The sandbox could not be created.", beforeSend: true };

// Red when: a live attempt is told its prompt was never sent, whatever is
// known about capture.
test("a live attempt that has not sent yet says so", () => {
  assert.deepEqual(explain({}), { schemaVersion: 1, kind: "not_sent_yet" });
  assert.deepEqual(explain({ promptSent: "unknown", attemptState: "waiting_loop" }), {
    schemaVersion: 1,
    kind: "not_sent_yet",
  });
});

// Red when: code from before capture that is still preparing is reported as
// "predates capture", which tells a person the prompt went out and was not
// kept while it has not gone out yet.
test("an attempt on code from before capture that is still preparing is not sent yet", () => {
  assert.deepEqual(explain({ captureCapable: false, promptSent: "unknown" }), { schemaVersion: 1, kind: "not_sent_yet" });
  assert.deepEqual(explain({ captureCapable: null }), { schemaVersion: 1, kind: "not_sent_yet" });
});

// Red when: a run status this build does not know makes a live attempt read
// as over. The attempt row is the fact recorded; the status is only newer.
test("a live attempt on a run status this build does not know is not sent yet", () => {
  assert.deepEqual(explain({ runStatus: "paused_by_operator", promptSent: "unknown" }), {
    schemaVersion: 1,
    kind: "not_sent_yet",
  });
});

// Red when: the switch or the code version is decided before whether the
// prompt went out, so a run that failed while preparing says "capture was
// off" instead of "the agent got nothing, here is why".
test("an attempt that failed while preparing was never sent, even with capture off", () => {
  const reason = explain({ attemptState: "failed", runStatus: "failed", failure: preparing, captureDisabled: true });
  assert.deepEqual(reason, {
    schemaVersion: 1,
    kind: "never_sent",
    attemptState: "failed",
    runStatus: "failed",
    failure: { category: "sandbox", message: "The sandbox could not be created." },
  });
  assert.equal(readVisibilityRecord(missingBriefingReasonSchema, JSON.parse(JSON.stringify(reason))).ok, true);
});

// Red when: code from before capture hides a failure before the send behind
// "predates capture".
test("an attempt on code from before capture that failed before sending was never sent", () => {
  assert.equal(explain({ attemptState: "failed", runStatus: "failed", failure: preparing, captureCapable: false, promptSent: "unknown" }).kind, "never_sent");
  assert.equal(explain({ attemptState: "failed", runStatus: "failed", captureCapable: null, promptSent: false }).kind, "never_sent");
});

// Red when: an attempt row still saying "running" on a run that failed is
// reported as "not sent yet", which a person would wait on forever.
test("an attempt row that says running on a failed run was never sent", () => {
  const failure = { category: "sandbox", message: "The sandbox stopped responding." };
  assert.deepEqual(explain({ runStatus: "failed", failure, promptSent: "unknown" }), {
    schemaVersion: 1,
    kind: "never_sent",
    attemptState: "running",
    runStatus: "failed",
    failure,
  });
  assert.equal(explain({ runStatus: "blocked" }).kind, "never_sent");
  assert.deepEqual(explain({ attemptState: "cancelled", runStatus: "blocked", promptSent: "unknown" }), {
    schemaVersion: 1,
    kind: "never_sent",
    attemptState: "cancelled",
    runStatus: "blocked",
    failure: null,
  });
});

// Red when: waiting for an answer is treated as live whatever was captured,
// or as over whatever was captured. Discovery then a question means the pass
// is still ahead; a pass that asked the question had sent its prompt.
test("waiting for an answer is not sent yet only between discovery and the pass", () => {
  const waiting = { attemptState: "waiting_for_clarification", runStatus: "awaiting", promptSent: "unknown" as const };
  assert.deepEqual(explain({ ...waiting, capturedKinds: ["discovery"] }), { schemaVersion: 1, kind: "not_sent_yet" });
  assert.deepEqual(explain({ ...waiting, capturedKinds: ["discovery", "agent"] }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "capture_skipped",
  });
  assert.deepEqual(explain({ ...waiting, capturedKinds: [] }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "capture_skipped",
  });
  // The run ended while waiting, before the pass: the pass never went out.
  assert.equal(explain({ ...waiting, runStatus: "failed", capturedKinds: ["discovery"] }).kind, "never_sent");
});

// Red when: "predates capture" is decided from a date: a run pinned to an old
// deployment starts attempts long after the new code shipped, and this facts
// shape has no date to be fooled by.
test("a sent prompt on code without capture predates capture, whenever it started", () => {
  assert.deepEqual(explain({ captureCapable: false, promptSent: true, attemptState: "completed", runStatus: "success" }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "predates_capture",
  });
  assert.deepEqual(explain({ captureCapable: null, promptSent: "unknown", attemptState: "completed", runStatus: "success" }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "predates_capture",
  });
});

// Red when: the current setting, or nothing at all, is reported instead of
// the setting recorded when the attempt ran.
test("capture switched off for the attempt says so", () => {
  assert.deepEqual(explain({ captureDisabled: true, promptSent: true, attemptState: "completed", runStatus: "success" }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "capture_disabled",
  });
});

// Red when: a completed attempt with capture on and no briefing gets a generic
// answer instead of "capture skipped".
test("a completed attempt whose briefing was not written says capture was skipped", () => {
  assert.deepEqual(explain({ attemptState: "completed", runStatus: "success", promptSent: "unknown" }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "capture_skipped",
  });
});

/** A block that asks a model only when it cannot work the answer out itself,
 *  finished, on a run that is over and lost no record: the shape of every
 *  ticket that names its own repository. */
const resolvedWithoutAsking = {
  attemptState: "completed",
  runStatus: "success",
  promptSent: "unknown" as const,
  sendsEveryAttempt: false,
};

// Red when: a block that asks a model only when it needs to is told its record
// was lost for every attempt that did not need to ask. That is a false alarm
// on the COMMON case (a ticket that names its repository), and it sends a
// person hunting a data-loss bug that does not exist.
test("an attempt that never needed to ask says so, and quotes no failure", () => {
  const reason = explain(resolvedWithoutAsking);
  assert.deepEqual(reason, {
    schemaVersion: 1,
    kind: "never_sent",
    cause: "not_needed",
    attemptState: "completed",
    runStatus: "success",
    failure: null,
  });
  assert.equal(readVisibilityRecord(missingBriefingReasonSchema, JSON.parse(JSON.stringify(reason))).ok, true);
});

// Red when: a run that failed somewhere else lends its failure to an attempt
// that simply had nothing to ask, which reads as the reason it asked nothing.
test("a run that failed elsewhere does not become the reason this attempt asked nothing", () => {
  const reason = explain({
    ...resolvedWithoutAsking,
    runStatus: "failed",
    failure: { category: "provider", message: "The AI provider rejected the request." },
  });
  assert.deepEqual(reason, {
    schemaVersion: 1,
    kind: "never_sent",
    cause: "not_needed",
    attemptState: "completed",
    runStatus: "failed",
    failure: null,
  });
});

// Red when: "it did not need to ask" is claimed on a run that DID lose a
// record. That is a false all-clear on the one run where something really is
// wrong, and it is the only thing that tells the two silences apart.
test("a run that lost a record keeps the louder answer for a block that may not have asked", () => {
  assert.deepEqual(explain({ ...resolvedWithoutAsking, runLostASend: true }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "capture_skipped",
  });
});

// Red when: the new answer overrules its two neighbours. A send that really
// was lost left a marker row saying it went out; an attempt that died before
// sending has its failure to read. Neither is "there was nothing to ask".
test("a block that may not have asked keeps both neighbouring answers", () => {
  assert.deepEqual(explain({ ...resolvedWithoutAsking, promptSent: true }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "capture_skipped",
  });
  const failure = { category: "sandbox", message: "The sandbox could not be created." };
  assert.deepEqual(explain({ ...resolvedWithoutAsking, attemptState: "failed", runStatus: "failed", failure }), {
    schemaVersion: 1,
    kind: "never_sent",
    attemptState: "failed",
    runStatus: "failed",
    failure,
  });
});

// Red when: a cause a newer worker writes makes the whole reason unreadable,
// so a dashboard one deploy behind shows nothing at all instead of what it
// still knows: the prompt never went out.
test("a never-sent cause this build does not know still reads", () => {
  const read = readVisibilityRecord(missingBriefingReasonSchema, {
    schemaVersion: 1,
    kind: "never_sent",
    cause: "sampled_out",
    attemptState: "completed",
    runStatus: "success",
    failure: null,
  });
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.value.kind === "never_sent" && read.value.cause, "sampled_out");
});

// Red when: an expired replay is claimed for an attempt that never had a
// briefing, or a captured briefing that expired is called something else.
test("expired only when a briefing was captured and the replay expired", () => {
  const gone = { replayExpired: true, attemptState: null, runStatus: "success", promptSent: "unknown" as const };
  assert.deepEqual(explain({ ...gone, capturedKinds: ["agent"] }), { schemaVersion: 1, kind: "expired" });
  assert.deepEqual(explain({ ...gone, captureCapable: false }), {
    schemaVersion: 1,
    kind: "not_recorded",
    cause: "predates_capture",
  });
});

// Red when: the discovery briefing of a planning attempt hides the planning
// pass that never went out.
test("a discovery briefing does not hide a planning pass that was never sent", () => {
  const failure = { category: "provider", message: "The model provider refused the request." };
  const reason = explain({
    attemptState: "failed",
    runStatus: "failed",
    failure,
    promptSent: "unknown",
    capturedKinds: ["discovery"],
    captureCapable: null,
  });
  assert.deepEqual(reason, { schemaVersion: 1, kind: "never_sent", attemptState: "failed", runStatus: "failed", failure });
});

// Red when: a failure message longer than a reader accepts makes the reason
// itself unreadable.
test("a long failure message is shortened, saying so", () => {
  const reason = explain({
    attemptState: "failed",
    runStatus: "failed",
    failure: { category: "sandbox", message: "x".repeat(5_000) },
  });
  const message = reason.kind === "never_sent" ? reason.failure!.message : "";
  assert.equal(message.length, 2_000);
  assert.match(message, /\u2026 \(5000 characters in full\)$/);
  assert.equal(readVisibilityRecord(missingBriefingReasonSchema, reason).ok, true);
});
