// apps/dashboard/lib/workflow-editor/prompt-preview.test.ts
//
// The mistakes these guard are all the same shape: saying nothing where the
// worker said something, and so letting an operator read a preview as a
// promise it does not make. A switch that is ON still needs a sentence,
// because silence about it reads as an absence; a profile case this build
// does not know must be shown, not guessed; and a source whose fate this build
// cannot classify must be neither cried wolf over nor waved through.
import assert from "node:assert/strict";
import test from "node:test";

import { contextLines, gapTitle, profileLine, sourceFate } from "./prompt-preview";

test("a switch that is on gets a sentence too, because silence reads as absence", () => {
  const lines = contextLines({ includeWorkflowData: true, includeRepositoryInstructions: true });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.sends));
  assert.match(lines[0]!.text, /receives workflow data/);
  // The one part of the old caveat that is still a guess, kept where it is true.
  assert.match(lines[0]!.text, /examples built from each binding/);
  assert.match(lines[1]!.text, /receives the repository instructions/);
});

test("a switch that is off says the section is not coming, not that it is not shown", () => {
  const lines = contextLines({ includeWorkflowData: false, includeRepositoryInstructions: false });
  assert.ok(lines.every((line) => !line.sends));
  assert.match(lines[0]!.text, /no workflow data/);
  assert.doesNotMatch(lines[0]!.text, /examples built from each binding/);
  assert.match(lines[1]!.text, /not coming, here or on a run/);
});

test("which profile compiled this prompt is said, including a case this build does not know", () => {
  assert.equal(
    profileLine({ profileId: "p", version: 4, name: "Review", applied: "selected" }),
    "Review v4, the profile this block selects",
  );
  assert.match(
    profileLine({ profileId: "p", version: 1, name: "Codex", applied: "builtin" }),
    /built-in profile a run uses when a block selects none/,
  );
  // A newer worker's case, shown as itself rather than folded into one of ours.
  assert.match(profileLine({ profileId: "p", version: 2, name: "Codex", applied: "pinned" }), /\(pinned\)/);
  assert.equal(profileLine(null), "No Harness Profile applied");
  assert.equal(profileLine(undefined), "No Harness Profile applied");
});

test("only the worker's own word makes a source fatal", () => {
  assert.equal(sourceFate("fails_the_run"), "fatal");
  assert.equal(sourceFate("filled_at_run"), "at_run");
  assert.equal(sourceFate("not_in_preview"), "not_here");
  // A worker older than the contract, and a fate a newer one knows: neither is
  // a claim, and neither may be read as "this is fine".
  assert.equal(sourceFate(undefined), "unsaid");
  assert.equal(sourceFate("retried_at_run"), "unsaid");
});

test("a section only a run composes is named, or spelled as the worker spelled it", () => {
  assert.equal(gapTitle("repository_instructions"), "Repository instructions");
  assert.equal(gapTitle("repository_memory"), "Repo memory");
  assert.equal(gapTitle("skills_bundle"), "skills_bundle");
});
