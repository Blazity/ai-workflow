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
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
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
    schedule?: Array<{ cron?: string }>;
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

const CI = workflowPaths[0];
const E2E = workflowPaths[1];

async function loadWorkflows(): Promise<Array<[string, Workflow]>> {
  return Promise.all(
    workflowPaths.map(async (path) => [
      path,
      parse(await readFile(path, "utf8")) as Workflow,
    ]),
  );
}

/**
 * The e2e suites live in one workflow now. They used to be duplicated into
 * `ci.yml` behind `merge_group`, which cannot fire (no merge queue is
 * configured), so that copy never ran and drifted from this one instead. These
 * assertions therefore hold the line on the file that actually runs, and the
 * "no live environment" test below holds the line on the file that must never
 * grow them back.
 */
async function loadE2e(): Promise<Array<[string, Workflow]>> {
  return [[E2E, parse(await readFile(E2E, "utf8")) as Workflow]];
}

test("all E2E jobs share the repository-wide non-canceling max queue", async () => {
  for (const [path, workflow] of await loadE2e()) {
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

  for (const [path, workflow] of await loadE2e()) {
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

test("the source gate carries no secret, no environment and no e2e job", async () => {
  const source = await readFile(CI, "utf8");
  const workflow = parse(source) as Workflow;

  // The strong form, and the reason the duplicated copies could go: a source
  // gate proves the checkout compiles and nothing else. One `secrets.` in this
  // file is a job that can reach a live tenant on an untrusted pull request.
  assert.doesNotMatch(source, /secrets\./, `${CI} must not reference any secret`);
  assert.doesNotMatch(source, /^\s*environment:/m, `${CI} must not name an environment`);
  for (const jobName of Object.keys(workflow.jobs ?? {})) {
    assert.doesNotMatch(jobName, /e2e/, `${CI} must not define ${jobName}`);
  }
});

test("the nightly schedule reaches the two tiers that cost nothing to repeat", async () => {
  const [, workflow] = (await loadE2e())[0]!;

  const cron = workflow.on?.schedule?.[0]?.cron;
  assert.ok(cron, "e2e.yml must carry a schedule");
  assert.doesNotMatch(cron, /^0 /, "an on-the-hour cron queues behind everything GitHub fires at :00");

  // A schedule run receives no inputs, so a job whose condition only reads
  // `inputs.tier` is skipped and the nightly silently covers nothing.
  for (const jobName of ["e2e-orchestration", "e2e-capacity"]) {
    assert.match(
      workflow.jobs?.[jobName]?.if ?? "",
      /github\.event_name == 'schedule'/,
      `${jobName} would be skipped on the nightly`,
    );
  }
});

test("the agent tier stays off the schedule, where nobody watches the spend", async () => {
  const [, workflow] = (await loadE2e())[0]!;

  assert.doesNotMatch(
    workflow.jobs?.["e2e-agent"]?.if ?? "",
    /github\.event_name == 'schedule'/,
    "the agent tier launches a real provider run; a nightly spends budget unwatched",
  );
});

test("a nightly failure opens one issue and keeps using it", async () => {
  const [, workflow] = (await loadE2e())[0]!;
  const report = workflow.jobs?.["report-nightly-failure"];
  assert.ok(report, "e2e.yml must report a nightly failure somewhere");

  assert.match(report.if ?? "", /github\.event_name == 'schedule'/);
  assert.match(report.if ?? "", /always\(\)/);
  assert.match(report.if ?? "", /contains\(needs\.\*\.result, 'failure'\)/);
  assert.equal(report.permissions?.issues, "write");
  assert.deepEqual(report.needs, ["e2e-orchestration", "e2e-capacity", "e2e-agent"]);

  const script = report.steps?.map((step) => step.run ?? "").join("\n") ?? "";
  // Both halves, or this is a job that files a fresh ticket every night.
  assert.match(script, /gh issue list/, "must look for the open issue first");
  assert.match(script, /gh issue comment/, "a repeat failure comments");
  assert.match(script, /gh issue create/, "the first failure opens the issue");
});

test("every e2e job carries the commenter token its agent tier fails without", async () => {
  const [, workflow] = (await loadE2e())[0]!;

  // us06-clarification-answered throws when this is missing, deliberately, so
  // that a skipped resume path cannot report the same green as an exercised
  // one. It was present only on the ci.yml copies that never ran.
  for (const jobName of ["e2e-orchestration", "e2e-capacity", "e2e-agent"]) {
    assert.equal(
      workflow.jobs?.[jobName]?.env?.JIRA_E2E_COMMENTER_TOKEN,
      "${{ secrets.JIRA_E2E_COMMENTER_TOKEN }}",
      `${jobName} is missing JIRA_E2E_COMMENTER_TOKEN`,
    );
  }
});

test("every e2e tier proves the deployment reads the branch it writes to", async () => {
  const [, workflow] = (await loadE2e())[0]!;

  for (const jobName of ["e2e-orchestration", "e2e-capacity", "e2e-agent"]) {
    const job = workflow.jobs?.[jobName];
    const preflight = job?.steps?.find((step) =>
      (step.run ?? "").includes("verify-deployment-identity"),
    );
    assert.ok(preflight, `${jobName} does not verify deployment identity`);

    // Without --database-url this degrades to a commit check on a dispatch and
    // to nothing at all on the nightly, which is the whole failure it exists to
    // prevent: check-db.ts already says it cannot tell two migrated branches
    // apart.
    assert.match(preflight.run ?? "", /--database-url/, `${jobName} must tie the branch`);

    const testStep = job?.steps?.findIndex((step) =>
      (step.run ?? "").startsWith("pnpm run test:e2e"),
    );
    assert.ok(
      job!.steps!.indexOf(preflight) < testStep!,
      `${jobName} must verify before it runs anything against the deployment`,
    );
  }
});
