import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

test("preparation workflow opens a reviewed source-only release-notes PR", async () => {
  const source = await readFile(".github/workflows/prepare-artur-release.yml", "utf8");
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "version",
    "previous_ref",
    "dry_run",
  ]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions["pull-requests"], "read");
  assert.match(source, /owner: Blazity/);
  assert.match(source, /repositories: ai-workflow(?:\n|$)/);
  assert.match(source, /id: source-read-token[\s\S]*?repositories: ai-workflow/);
  assert.match(source, /id: artur-read-token[\s\S]*?repositories: ai-workflow-arthur/);
  assert.match(source, /GH_TOKEN: \$\{\{ steps\.source-read-token\.outputs\.token \}\}/);
  assert.match(source, /ARTUR_GH_TOKEN: \$\{\{ steps\.artur-read-token\.outputs\.token \}\}/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /peter-evans\/create-pull-request@v7/);
  assert.doesNotMatch(source, /git remote set-url|x-access-token|pull_request_target/);
  const runScripts = workflow.jobs.prepare.steps
    .flatMap((step: { run?: string }) => (step.run ? [step.run] : []))
    .join("\n");
  assert.doesNotMatch(runScripts, /\$\{\{ inputs\./);
  const steps = workflow.jobs.prepare.steps as Array<{ id?: string; name?: string }>;
  assert.ok(
    steps.findIndex((step) => step.id === "source-read-token") <
      steps.findIndex((step) => step.name === "Generate release notes") &&
      steps.findIndex((step) => step.id === "artur-read-token") <
      steps.findIndex((step) => step.name === "Generate release notes"),
  );
});

test("synchronization workflow opens a full snapshot PR in the Artur repository", async () => {
  const source = await readFile(".github/workflows/sync-artur-release.yml", "utf8");
  const workflow = parse(source);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.paths, ["docs/releases/artur/*.md"]);
  assert.ok(workflow.on.workflow_dispatch);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions["pull-requests"], "read");
  assert.match(source, /repositories: ai-workflow-arthur/);
  assert.match(source, /repository: Blazity\/ai-workflow-arthur/);
  assert.match(source, /ref: \$\{\{ steps\.source\.outputs\.target_sha \}\}/);
  assert.match(source, /release-notes validate-source/);
  assert.match(source, /release-notes sync-artur/);
  assert.match(source, /ARTUR_INITIAL_BASE_SHA/);
  assert.match(source, /peter-evans\/create-pull-request@v7/);
  assert.match(source, /<!-- artur-release/);
  assert.match(source, /persist-credentials: false/g);
  assert.doesNotMatch(
    source,
    /vercel deploy|VERCEL_PROJECT_ID|ARTUR_WORKER_(BASE_)?URL|ARTUR_DASHBOARD_(BASE_)?URL/,
  );
  assert.doesNotMatch(source, /pull_request_target|PERSONAL_ACCESS_TOKEN|git remote set-url/);
});

test("source repository no longer contains a direct Artur deployment workflow", async () => {
  await assert.rejects(access(".github/workflows/release-artur.yml"));
});
