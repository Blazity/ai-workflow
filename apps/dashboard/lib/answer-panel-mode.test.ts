import { test } from "node:test";
import assert from "node:assert/strict";
import { answerPanelMode } from "./answer-panel-mode";

test("pending clarification shows the form regardless of run status", () => {
  assert.equal(answerPanelMode("pending", "awaiting", false), "form");
  assert.equal(answerPanelMode("pending", "running", false), "form");
});

test("answered clarification with a progressing or finished run reads as resumed", () => {
  for (const runStatus of ["running", "success", "failed", "blocked"] as const) {
    assert.equal(answerPanelMode("answered", runStatus, false), "resumed");
  }
});

test("answered clarification on a run still awaiting offers the retry", () => {
  assert.equal(answerPanelMode("answered", "awaiting", false), "retry");
});

test("a fresh successful submit renders as resumed even while props lag", () => {
  assert.equal(answerPanelMode("answered", "awaiting", true), "resumed");
  assert.equal(answerPanelMode("pending", "awaiting", true), "resumed");
});

test("superseded clarification hides the panel", () => {
  assert.equal(answerPanelMode("superseded", "running", false), "hidden");
  assert.equal(answerPanelMode("superseded", "awaiting", true), "hidden");
});
