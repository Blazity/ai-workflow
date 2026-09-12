import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

type PackageJson = {
  scripts: Record<string, string>;
};

function commands(script: string): string[] {
  return script.split(" && ");
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}

test("main pushes run CI in a non-canceling concurrency group", async () => {
  const source = await readFile(".github/workflows/ci.yml", "utf8");
  const workflow = parse(source) as {
    on: { push: { branches: string[] } };
    concurrency: { group: string; "cancel-in-progress": boolean };
  };

  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(
    workflow.concurrency.group,
    /github\.event_name == 'push' && github\.sha/,
  );
});

test("CI preserves every authoritative source trigger", async () => {
  const source = await readFile(".github/workflows/ci.yml", "utf8");
  const workflow = parse(source) as {
    on: Record<string, unknown> & {
      pull_request: { branches: string[] };
      push: { branches: string[] };
    };
  };

  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "merge_group",
    "pull_request",
    "push",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request, { branches: ["main", "dev"] });
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
});

/**
 * The source gate used to be one serial job. It is now four parallel jobs plus
 * an aggregate, which is only safe if the split provably drops nothing and if
 * none of the pieces can be skipped or reach a live environment. These three
 * tests hold exactly those lines, together, rather than pinning one job's steps.
 */
const SOURCE_JOBS = ["source-checks", "unit-worker", "unit-dashboard", "workflow-sdk"] as const;

const DIFF_CHECK_COMMAND = [
  'base="${{ github.event_name == \'pull_request\' && github.event.pull_request.base.sha || github.event_name == \'push\' && github.event.before || \'\' }}"',
  'if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ]; then',
  '  echo "::notice::No usable diff base, skipping git diff --check."',
  "  exit 0",
  "fi",
  'git diff --check "$base...HEAD"',
].join("\n");

/** Every command the source gate must still run, wherever it now lives. */
const SOURCE_COMMANDS = [
  DIFF_CHECK_COMMAND,
  "pnpm --filter ai-workflow-dashboard run test",
  "pnpm --filter worker exec vitest run --shard=${{ matrix.shard }}/4",
  "pnpm install --frozen-lockfile",
  "pnpm run build:ci",
  "pnpm run gates",
  "pnpm run gen:blocks --check",
  "pnpm run test:ci",
  "pnpm run test:packages",
  "pnpm run test:release-notes",
  "pnpm run test:workflow-sdk",
  "pnpm run typecheck",
];

interface CiJob {
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  environment?: unknown;
  if?: string;
  needs?: string[];
  "timeout-minutes"?: number;
  steps?: Array<{
    "continue-on-error"?: boolean;
    env?: Record<string, string>;
    if?: string;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
  }>;
}

async function ciJobs(): Promise<Record<string, CiJob>> {
  const source = await readFile(".github/workflows/ci.yml", "utf8");
  return (parse(source) as { jobs: Record<string, CiJob> }).jobs;
}

test("the source gate splits into parallel jobs without dropping a check", async () => {
  const jobs = await ciJobs();

  for (const name of SOURCE_JOBS) {
    assert.ok(jobs[name], `ci.yml must define the source job "${name}"`);
    assert.equal(jobs[name]?.needs, undefined, `"${name}" must not wait on another job`);
  }

  const commands = new Set<string>();
  for (const name of SOURCE_JOBS) {
    for (const step of jobs[name]?.steps ?? []) {
      if (typeof step.run === "string") commands.add(step.run.trim());
    }
  }

  assert.deepEqual(
    [...commands].sort(),
    SOURCE_COMMANDS,
    "the parallel source jobs must run exactly the commands the serial job ran",
  );
});

test("the whitespace check compares the event base through HEAD", async () => {
  const jobs = await ciJobs();
  const steps = jobs["source-checks"].steps ?? [];
  const checkout = steps.find((step) => step.uses === "actions/checkout@v4");
  const diffCheck = steps.find((step) => step.run?.includes("git diff --check"));

  assert.equal(checkout?.with?.["fetch-depth"], 0);
  assert.equal(diffCheck?.run?.trim(), DIFF_CHECK_COMMAND);
});

test("no source job can be skipped or reach a live environment", async () => {
  const jobs = await ciJobs();

  for (const name of SOURCE_JOBS) {
    const job = jobs[name] as CiJob;
    assert.equal(job.if, undefined, `"${name}" must not be conditional`);
    assert.equal(job["continue-on-error"], undefined, `"${name}" must not continue on error`);
    assert.equal(job.environment, undefined, `"${name}" must not select an environment`);
    assert.equal(job.env, undefined, `"${name}" must not define job-level env`);
    assert.doesNotMatch(
      JSON.stringify(job),
      /\$\{\{[^}]*\bsecrets\b/,
      `"${name}" must not read secrets`,
    );
    for (const step of job.steps ?? []) {
      assert.equal(step.if, undefined, `"${name}" must not carry a conditional step`);
      assert.equal(
        step["continue-on-error"],
        undefined,
        `"${name}" must not carry a step that continues on error`,
      );
      assert.equal(step.env, undefined, `"${name}" must not carry step-level env`);
    }
  }
});

test("the required check fails when any source job does not succeed", async () => {
  const jobs = await ciJobs();
  const aggregate = jobs.ci as CiJob;

  assert.deepEqual(
    [...(aggregate.needs ?? [])].sort(),
    [...SOURCE_JOBS].sort(),
    "the required check must depend on every source job",
  );
  // Without always() a failed dependency leaves this job skipped, and GitHub
  // counts a skipped required check as satisfied.
  assert.equal(aggregate.if, "always()");
  assert.equal(aggregate.environment, undefined);
  assert.equal(aggregate.env, undefined);
  assert.doesNotMatch(JSON.stringify(aggregate), /\$\{\{[^}]*\bsecrets\b/);

  const script = (aggregate.steps ?? []).map((step) => step.run ?? "").join("\n");
  assert.match(script, /needs\.\*\.result/, "the check must read every dependency result");
  assert.match(script, /!=\s*"success"/, "the check must reject any non-success result");
  assert.match(script, /exit 1/, "the check must fail the job on a non-success result");
});

test("the source build covers worker and dashboard without deployment side effects", async () => {
  const rootPackage = await readPackageJson("package.json");
  const workerPackage = await readPackageJson("apps/worker/package.json");
  const dashboardPackage = await readPackageJson("apps/dashboard/package.json");

  assert.deepEqual(commands(rootPackage.scripts["build:ci"]), [
    "pnpm --filter worker build:ci",
    "NEXT_TELEMETRY_DISABLED=1 pnpm --filter ai-workflow-dashboard build",
  ]);
  assert.deepEqual(commands(workerPackage.scripts["build:ci"]), [
    "pnpm validate:pre-sandbox",
    "pnpm validate:local-skills",
    "pnpm mcp:contract:check",
    "pnpm --dir ../.. run gen:blocks -- --check",
    "rm -rf .nitro/workflow",
    "NODE_OPTIONS=--max-old-space-size=8192 nitro build",
  ]);
  assert.equal(
    dashboardPackage.scripts.build,
    "tsx ../../scripts/gates/generate-block-catalog.ts --check && next build",
  );
  assert.doesNotMatch(workerPackage.scripts["build:ci"], /db:migrate/);
  assert.doesNotMatch(workerPackage.scripts["build:ci"], /seed:auth-user/);
  // The settings seed writes rows, so it belongs to the build that owns the
  // database and not to the one CI runs against no database at all.
  assert.doesNotMatch(workerPackage.scripts["build:ci"], /db:seed-settings/);
});

test("the CI gate command reaches both database fences", async () => {
  const rootPackage = await readPackageJson("package.json");
  assert.match(rootPackage.scripts.gates, /gate:transactions/u);
  assert.match(rootPackage.scripts.gates, /gate:db-client-fence/u);
});

test("the source build uses the validator entrypoints and preserves deployment setup order", async () => {
  const workerPackage = await readPackageJson("apps/worker/package.json");

  assert.equal(
    workerPackage.scripts["validate:pre-sandbox"],
    "tsx scripts/validate-pre-sandbox-config.ts",
  );
  assert.equal(
    workerPackage.scripts["validate:local-skills"],
    "tsx scripts/validate-local-skills.ts",
  );
  assert.equal(
    workerPackage.scripts["mcp:contract:check"],
    "tsx scripts/generate-mcp-contract.ts --check",
  );
  assert.deepEqual(commands(workerPackage.scripts.build), [
    "pnpm validate:pre-sandbox",
    "pnpm validate:local-skills",
    "pnpm db:migrate",
    "pnpm db:seed-settings",
    "pnpm seed:auth-user",
    "pnpm --dir ../.. run gen:blocks -- --check",
    "rm -rf .nitro/workflow",
    "NODE_OPTIONS=--max-old-space-size=8192 nitro build",
  ]);
});

test("all setup-node workflow jobs use Node 24", async () => {
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/e2e.yml",
  ];
  let setupNodeJobs = 0;

  for (const workflowPath of workflowPaths) {
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as {
      jobs: Record<
        string,
        {
          steps?: Array<{
            uses?: string;
            with?: { "node-version"?: string | number };
          }>;
        }
      >;
    };

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const setupNodeSteps = job.steps?.filter((step) =>
        step.uses?.startsWith("actions/setup-node@"),
      );
      if (!setupNodeSteps?.length) continue;

      setupNodeJobs += 1;
      for (const step of setupNodeSteps) {
        assert.equal(
          String(step.with?.["node-version"]),
          "24",
          `${workflowPath}: job "${jobName}" must use Node 24`,
        );
      }
    }
  }

  // Four source jobs in ci.yml (the `ci` aggregate installs nothing) and three
  // e2e tiers in e2e.yml. The count is pinned so a new job cannot quietly join
  // on an older Node; it dropped from ten when the three e2e tiers duplicated
  // into ci.yml behind an unreachable `merge_group` were removed.
  assert.equal(
    setupNodeJobs,
    7,
    `expected 7 setup-node jobs across CI workflows, found ${setupNodeJobs}`,
  );
});
