import assert from "node:assert/strict";
import test from "node:test";

import { runModelLabel, UNKNOWN_MODEL_LABEL } from "./run-model";

test("runModelLabel passes an attributed model through unchanged", () => {
  assert.equal(runModelLabel("gpt-5.6-sol"), "gpt-5.6-sol");
});

test("runModelLabel renders an explicit unknown when nothing is attributed", () => {
  assert.equal(runModelLabel(null), UNKNOWN_MODEL_LABEL);
  assert.equal(runModelLabel(undefined), UNKNOWN_MODEL_LABEL);
});
