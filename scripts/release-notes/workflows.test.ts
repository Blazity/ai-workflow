import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

test("preparation workflow is manual, reviewable, and dry-run safe", async () => {
  const source = await readFile(".github/workflows/prepare-artur-release.yml", "utf8");
  const workflow = parse(source);
  const dispatch = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(dispatch), ["version", "previous_ref", "target_ref", "dry_run"]);
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(workflow.permissions["pull-requests"], "write");
  assert.match(source, /actions\/create-github-app-token@v3/);
  assert.match(source, /actions\/upload-artifact@v4/);
  assert.match(source, /release\/artur-/);
  assert.match(source, /gh pr create/);
  assert.doesNotMatch(source, /pull_request_target|PERSONAL_ACCESS_TOKEN/);
});
