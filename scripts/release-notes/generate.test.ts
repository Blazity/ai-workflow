import assert from "node:assert/strict";
import test from "node:test";

import { generateReleaseDraft } from "./generate.js";
import { collection } from "./test-fixtures.js";

test("validates structured model output and its source PRs", async () => {
  const draft = await generateReleaseDraft(collection, async (prompt) => {
    assert.match(prompt, /GitLab support/);
    assert.doesNotMatch(prompt, /diff/);
    return JSON.stringify({
      highlights: "AI Workflow now works with more development environments.",
      features: [{ text: "Teams can use GitLab repositories.", sources: [7] }],
      improvementsAndFixes: [],
      requiredAction: "No action is required.",
      knownLimitations: "No known user-facing limitations.",
    });
  });
  assert.equal(draft.generatedBy, "ai");
  assert.deepEqual(draft.features[0].sources, [7]);
});

test("falls back deterministically when the model fails", async () => {
  const draft = await generateReleaseDraft(collection, async () => {
    throw new Error("provider unavailable");
  });
  assert.equal(draft.generatedBy, "fallback");
  assert.deepEqual(draft.features, [{ text: "Use GitLab repositories.", sources: [7] }]);
});

test("rejects sources outside the selected release", async () => {
  await assert.rejects(
    generateReleaseDraft(collection, async () =>
      JSON.stringify({
        highlights: "Update",
        features: [{ text: "Unsupported claim.", sources: [999] }],
        improvementsAndFixes: [],
        requiredAction: "None.",
        knownLimitations: "None.",
      }),
    ),
    /unknown PR #999/,
  );
});
