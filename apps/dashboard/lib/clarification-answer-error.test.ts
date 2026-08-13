import assert from "node:assert/strict";
import test from "node:test";

import { clarificationAnswerErrorMessage } from "./clarification-answer-error";

test("every code the answer endpoint replies with becomes a sentence", () => {
  for (const code of [
    "already_answered",
    "ticket_gone",
    "clarification_transition_failed",
    "clarification_resume_failed",
    "invalid_answer",
  ]) {
    const message = clarificationAnswerErrorMessage(code);
    assert.notEqual(message, code, `${code} is still rendered raw`);
    assert.match(message, /[a-z] [a-z]/, `${code} did not map to prose`);
  }
});

// A message from anywhere else in the stack is the only detail the reader has, so
// it must survive rather than be replaced by a generic line.
test("an unmapped message is passed through unchanged", () => {
  assert.equal(
    clarificationAnswerErrorMessage("Unknown clarification"),
    "Unknown clarification",
  );
});
