import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

test("preparation workflow is manual, reviewable, and dry-run safe", async () => {
  const source = await readFile(".github/workflows/prepare-artur-release.yml", "utf8");
  const workflow = parse(source);
  const dispatch = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(dispatch), ["version", "previous_ref", "dry_run"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions["pull-requests"], "read");
  assert.equal(workflow.jobs.prepare.environment, "artur-release-preparation");
  assert.match(source, /ref: main/);
  assert.match(source, /actions\/create-github-app-token@v3/);
  assert.match(source, /actions\/upload-artifact@v4/);
  assert.match(source, /release\/artur-/);
  assert.match(source, /gh pr create/);
  assert.doesNotMatch(source, /pull_request_target|PERSONAL_ACCESS_TOKEN/);
  assert.doesNotMatch(source, /target_ref/);
});

test("release workflow validates, deploys, verifies, and publishes in order", async () => {
  const source = await readFile(".github/workflows/release-artur.yml", "utf8");
  const workflow = parse(source);
  const dispatch = workflow.on.workflow_dispatch.inputs;

  assert.deepEqual(Object.keys(dispatch), ["version"]);
  assert.equal(workflow.concurrency.group, "artur-production-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.deploy.environment, "artur-production");
  assert.equal(workflow.jobs.deploy.needs, "validate");
  assert.equal(workflow.permissions.actions, "read");
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions["pull-requests"], "read");
  assert.equal(workflow.jobs.deploy.permissions.contents, "write");

  const requiredConfiguration = [
    "VERCEL_TOKEN",
    "ARTUR_SESSION_TOKEN",
    "VERCEL_ORG_ID",
    "ARTUR_WORKER_PROJECT_ID",
    "ARTUR_DASHBOARD_PROJECT_ID",
    "ARTUR_WORKER_BASE_URL",
    "ARTUR_DASHBOARD_BASE_URL",
    "ARTUR_WORKFLOW_DEFINITION_ID",
  ];
  for (const name of requiredConfiguration) assert.match(source, new RegExp(name));

  assert.match(source, /candidateCommit/);
  assert.match(source, /pnpm test:release-notes/);
  assert.match(source, /actions\/runs\/\$\{?GITHUB_RUN_ID\}?\/approvals/);
  assert.match(source, /--initiated-by "\$\{GITHUB_ACTOR\}"/);
  assert.match(source, /--approved-by "\$\{\{ steps\.approval\.outputs\.approved_by \}\}"/);
  assert.match(source, /vercel@52\.0\.0 deploy --prod --skip-domain/);
  assert.match(source, /\/health/);
  assert.match(source, /\/login/);
  assert.match(source, /vercel@52\.0\.0 promote/);
  assert.match(source, /api\/v1\/workflow-definitions/);
  assert.match(source, /expectedDraftRevision/);
  assert.match(source, /expectedDeployedVersion/);
  assert.match(source, /gh release create/);
  assert.match(source, /release-manifest\.json/);
  assert.match(source, /GITHUB_STEP_SUMMARY/);

  const validationIndex = source.indexOf("release-notes validate");
  const environmentIndex = source.indexOf("environment: artur-production");
  const publicationIndex = source.indexOf("gh release create");
  assert.ok(validationIndex >= 0 && validationIndex < environmentIndex);
  assert.ok(publicationIndex > source.indexOf("Smoke-test Artur production"));
});
