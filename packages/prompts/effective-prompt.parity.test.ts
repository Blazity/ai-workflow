import assert from "node:assert/strict";
import test from "node:test";
import { compileEffectivePrompt } from "./index";
import {
  EFFECTIVE_PROMPT_PARITY_EXPECTED,
  EFFECTIVE_PROMPT_PARITY_INPUT,
} from "./effective-prompt.parity-fixture";

test("compiles the pre-move worker and dashboard parity fixture byte-identically", async () => {
  const actual = await compileEffectivePrompt({
    ...EFFECTIVE_PROMPT_PARITY_INPUT,
    inspectSlotSchema: () => ({ ok: true }),
    validateSlotValue: () => [],
    exampleValueForSchema: () => null,
  });

  assert.deepEqual(actual, EFFECTIVE_PROMPT_PARITY_EXPECTED);
});
