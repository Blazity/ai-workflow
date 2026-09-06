import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  if?: string;
  run?: string;
  "working-directory"?: string;
  "timeout-minutes"?: number;
};

type Job = {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
    queue?: string;
  };
  env?: Record<string, string>;
  steps?: Step[];
  "timeout-minutes"?: number;
};

type Workflow = {
  on?: {
    workflow_dispatch?: { inputs?: Record<string, unknown> } | null;
  };
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  jobs?: Record<string, Job>;
};

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/e2e.yml",
] as const;

async function loadWorkflows(): Promise<Array<[string, Workflow]>> {
  return Promise.all(
    workflowPaths.map(async (path) => [
      path,
      parse(await readFile(path, "utf8")) as Workflow,
    ]),
  );
}

test("all E2E jobs share the repository-wide non-canceling max queue", async () => {
  for (const [path, workflow] of await loadWorkflows()) {
    for (const jobName of [
      "e2e-orchestration",
      "e2e-capacity",
      "e2e-agent",
    ]) {
      const job = workflow.jobs?.[jobName];
      assert.ok(job, `${path} is missing ${jobName}`);
      assert.deepEqual(job.concurrency, {
        group: "aiw-e2e-${{ github.repository_id }}",
        "cancel-in-progress": false,
        queue: "max",
      });
    }
  }
});

test("CI outer concurrency cannot supersede secret-bearing E2E events", async () => {
  const [, workflow] = (await loadWorkflows())[0]!;
  const concurrency = workflow.concurrency;
  assert.ok(concurrency);
  assert.equal(concurrency["cancel-in-progress"], true);
  assert.match(concurrency.group ?? "", /github\.head_ref/);
  assert.match(
    concurrency.group ?? "",
    /github\.event_name == 'workflow_dispatch'/,
  );
  assert.match(concurrency.group ?? "", /github\.event_name == 'merge_group'/);
  assert.match(concurrency.group ?? "", /github\.run_id/);
  assert.match(concurrency.group ?? "", /github\.run_attempt/);
});

test("capacity jobs use trusted campaign identity and leave teardown time", async () => {
  const expectedIdentity =
    "${{ github.repository_id }}:${{ github.run_id }}:${{ github.run_attempt }}:e2e-capacity";
  const expectedMarker =
    "${{ github.workspace }}/.aiw-capacity-release-${{ github.run_id }}-${{ github.run_attempt }}.json";

  for (const [path, workflow] of await loadWorkflows()) {
    const capacity = workflow.jobs?.["e2e-capacity"];
    assert.ok(capacity, `${path} is missing e2e-capacity`);
    assert.equal(capacity["timeout-minutes"], 60);
    assert.equal(capacity.env?.E2E_CAPACITY_CAMPAIGN_ID, expectedIdentity);
    assert.equal(capacity.env?.E2E_CAPACITY_RELEASE_MARKER, expectedMarker);
    assert.doesNotMatch(JSON.stringify(capacity.env), /runner\.temp|github\.job/);
    assert.doesNotMatch(
      JSON.stringify(capacity.env),
      /inputs\..*campaign|campaign.*inputs\./i,
    );

    const testStep = capacity.steps?.find(
      (step) => step.name === "Run capacity E2E",
    );
    assert.ok(testStep, `${path} is missing the named capacity test step`);
    assert.equal(testStep["timeout-minutes"], 30);
    assert.equal(testStep.run, "pnpm run test:e2e:capacity");

    const finalizer = capacity.steps?.find(
      (step) => step.name === "Finalize capacity reservations",
    );
    assert.ok(finalizer, `${path} is missing the capacity finalizer`);
    assert.equal(finalizer.if, "always()");
    assert.equal(finalizer["timeout-minutes"], 10);
    assert.equal(finalizer["working-directory"], "apps/worker");
    assert.equal(finalizer.run, "pnpm exec tsx e2e/scripts/finalize-capacity.ts");
    assert.ok(
      capacity.steps!.indexOf(finalizer) > capacity.steps!.indexOf(testStep),
      `${path} must finalize after the bounded test step`,
    );
  }
});

test("manual workflow exposes no operator-provided campaign identity", async () => {
  const [, workflow] = (await loadWorkflows())[1]!;
  const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
  assert.equal(
    Object.keys(inputs).some((name) => /campaign/i.test(name)),
    false,
  );
});
