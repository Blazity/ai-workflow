import assert from "node:assert/strict";
import test from "node:test";

import { isHarnessProfileAuthoringEnabled } from "./rollout";

test("Harness Profile authoring requires the explicit preview-canary flag", () => {
  assert.equal(isHarnessProfileAuthoringEnabled(undefined), false);
  assert.equal(isHarnessProfileAuthoringEnabled("0"), false);
  assert.equal(isHarnessProfileAuthoringEnabled("true"), false);
  assert.equal(isHarnessProfileAuthoringEnabled("1"), true);
});
