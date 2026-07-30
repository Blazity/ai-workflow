import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPullRequest,
  extractReleaseFields,
  parseVersion,
} from "./classify.js";
import type { ReleasePullRequest } from "./types.js";

function pr(overrides: Partial<ReleasePullRequest> = {}): ReleasePullRequest {
  return {
    number: 42,
    title: "feat: add GitLab support",
    body: "",
    labels: [],
    mergedAt: "2026-07-30T10:00:00Z",
    mergeCommitSha: "a".repeat(40),
    url: "https://github.com/Blazity/ai-workflow/pull/42",
    ...overrides,
  };
}

test("accepts Artur calendar versions", () => {
  assert.equal(parseVersion("2026.08.0"), "2026.08.0");
  assert.throws(() => parseVersion("v2026.08.0"), /YYYY\.MM\.PATCH/);
  assert.throws(() => parseVersion("2026.13.0"), /YYYY\.MM\.PATCH/);
});

test("extracts release fields by Markdown heading", () => {
  assert.deepEqual(
    extractReleaseFields(`## User impact
Faster runs

## Required action
None

## Release note
Runs finish faster.

## Testing
Done`),
    {
      userImpact: "Faster runs",
      requiredAction: "None",
      releaseNote: "Runs finish faster.",
    },
  );
});

test("uses an explicit release classification", () => {
  const result = classifyPullRequest(pr({ labels: ["release:feature"] }));
  assert.equal(result.category, "feature");
  assert.equal(result.customerFacing, true);
  assert.equal(result.included, true);
});

test("rejects conflicting release labels", () => {
  assert.throws(
    () => classifyPullRequest(pr({ labels: ["release:feature", "release:fix"] })),
    /multiple release labels/,
  );
});

test("infers an unlabeled fix and reports the missing label", () => {
  const result = classifyPullRequest(pr({ title: "fix: keep runs resumable" }));
  assert.equal(result.category, "fix");
  assert.match(result.warnings.join("\n"), /missing a release label/);
});

test("keeps internal changes in the audit and skips explicit omissions", () => {
  const internal = classifyPullRequest(pr({ labels: ["release:internal"] }));
  assert.equal(internal.customerFacing, false);
  assert.equal(internal.included, true);

  const skipped = classifyPullRequest(pr({ labels: ["release:skip"] }));
  assert.equal(skipped.included, false);
});
