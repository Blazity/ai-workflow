import assert from "node:assert/strict";
import test from "node:test";

import {
  extractShareableNotes,
  parseReleaseNotes,
  renderReleaseNotes,
  validateReleaseNotes,
} from "./render.js";
import { collection } from "./test-fixtures.js";

const draft = {
  highlights: "AI Workflow now supports more development environments.",
  features: [{ text: "Teams can use GitLab repositories.", sources: [7] }],
  improvementsAndFixes: [],
  requiredAction: "No action is required.",
  knownLimitations: "No known user-facing limitations.",
  generatedBy: "ai" as const,
};

test("renders stable canonical Markdown with hidden traceability", () => {
  const first = renderReleaseNotes(collection, draft, "2026.08.0");
  const second = renderReleaseNotes(collection, draft, "2026.08.0");
  assert.equal(first, second);
  assert.match(first, /version: 2026\.08\.0/);
  assert.match(first, /<!-- shareable:start -->/);
  assert.match(first, /<!-- sources: 7 -->/);
  assert.match(first, /\[#7\]\(https:\/\/github\.com\/Blazity\/ai-workflow\/pull\/7\)/);
  assert.doesNotMatch(extractShareableNotes(first), /Exact release scope/);
});

test("parses and validates the expected release", () => {
  const markdown = renderReleaseNotes(collection, draft, "2026.08.0");
  assert.equal(parseReleaseNotes(markdown).metadata.targetCommit, "b".repeat(40));
  assert.deepEqual(validateReleaseNotes(markdown, "2026.08.0").sources, [7]);
});

test("rejects a customer bullet without a source comment", () => {
  const markdown = renderReleaseNotes(collection, draft, "2026.08.0").replace(
    "  <!-- sources: 7 -->",
    "",
  );
  assert.throws(() => validateReleaseNotes(markdown, "2026.08.0"), /source comment/);
});

test("requires every customer-facing PR in scope to be covered", () => {
  const markdown = renderReleaseNotes(collection, draft, "2026.08.0").replace(
    "- Teams can use GitLab repositories.\n  <!-- sources: 7 -->",
    "No new user-facing capabilities in this release.",
  );
  assert.throws(() => validateReleaseNotes(markdown, "2026.08.0"), /PR #7 is not covered/);
});

test("requires exact-scope links to use the frontmatter repository", () => {
  const markdown = renderReleaseNotes(collection, draft, "2026.08.0").replace(
    "github.com/Blazity/ai-workflow/pull/7",
    "github.com/Other/repository/pull/7",
  );
  assert.throws(() => validateReleaseNotes(markdown, "2026.08.0"), /Malformed exact release scope/);
});
