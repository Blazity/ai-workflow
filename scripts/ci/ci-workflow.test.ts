import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
/** What `ci` waits for: the source jobs and nothing else. The engine canary
 *  runs on demand in its own workflow and never gates a merge (ADR-004). */
const REQUIRED_JOBS = [...SOURCE_JOBS] as const;

const DIFF_CHECK_COMMAND = [
  "set -euo pipefail",
  'base="${{ github.event_name == \'pull_request\' && github.event.pull_request.base.sha || github.event_name == \'push\' && github.event.before || \'\' }}"',
  'if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ]; then',
  '  echo "::notice::No usable diff base, skipping git diff --check."',
  "  exit 0",
  "fi",
  'git diff --check "$base...HEAD"',
].join("\n");

const CHANGELOG_CHECK_STEP_NAME = "Require a changelog entry for product changes";

/**
 * The rule the step enforces is not pinned here. It used to be, as a verbatim
 * copy of forty lines of bash, which could only fail when somebody edited the
 * step and passed for every logic error the step could hold. The rule lives in
 * `scripts/ci/changelog-entry-gate.ts` now and its cases are tested by calling
 * it; what this file still owes is the wiring: that the step invokes that
 * script, reads its event fields through env:, and cannot be skipped.
 */
const CHANGELOG_CHECK_SCRIPT = "scripts/ci/changelog-entry-gate.ts";
const CHANGELOG_CHECK_COMMAND = `node --import tsx ${CHANGELOG_CHECK_SCRIPT}`;

/** Every command the source gate must still run, wherever it now lives. */
const SOURCE_COMMANDS = [
  CHANGELOG_CHECK_COMMAND,
  "pnpm --filter @shared/workflow-graph run test:zod4",
  "pnpm --filter ai-workflow-dashboard run test",
  "pnpm --filter worker exec vitest run --shard=${{ matrix.shard }}/4",
  "pnpm --filter worker run test:zod4",
  "pnpm install --frozen-lockfile",
  "pnpm run build:ci",
  "pnpm run gates",
  "pnpm run gen:blocks --check",
  "pnpm run gen:integrations --check",
  "pnpm run test:ci",
  "pnpm run test:packages",
  "pnpm run test:packages:zod4",
  "pnpm run test:release-notes",
  "pnpm run test:workflow-sdk",
  "pnpm run typecheck",
  DIFF_CHECK_COMMAND,
];

interface CiJob {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
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

const CANARY_WORKFLOW = ".github/workflows/engine-canary.yml";

interface CanaryWorkflow {
  on: Record<string, unknown> & {
    pull_request?: { types?: string[]; branches?: string[] };
    workflow_dispatch?: { inputs?: Record<string, { options?: string[]; default?: string }> };
  };
  jobs: Record<string, CiJob>;
}

async function canaryWorkflow(): Promise<CanaryWorkflow> {
  return parse(await readFile(CANARY_WORKFLOW, "utf8")) as CanaryWorkflow;
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
      if (step.name === CHANGELOG_CHECK_STEP_NAME) {
        // This step reads the pull request's own labels and files through
        // `gh`, which needs the default token and the PR number; GitHub's own
        // guidance against interpolating event fields into `run:` puts those,
        // plus the event name and fork flag the skip logic reads, through
        // env: instead. It is the one named exception: every other step in
        // these jobs stays free of step-level env, and the check just above
        // already proves this step (like every other) carries no secret.
        assert.deepEqual(Object.keys(step.env ?? {}).sort(), [
          "EVENT_NAME",
          "GH_TOKEN",
          "HEAD_IS_FORK",
          "PR_NUMBER",
        ]);
        continue;
      }
      assert.equal(step.env, undefined, `"${name}" must not carry step-level env`);
    }
  }
});

test("the changelog completeness check invokes the gate script, which holds the rule", async () => {
  const jobs = await ciJobs();
  const steps = jobs["source-checks"].steps ?? [];
  const step = steps.find((entry) => entry.name === CHANGELOG_CHECK_STEP_NAME);

  assert.ok(step, "source-checks must carry the changelog completeness check");
  assert.equal(step?.if, undefined, "the check must not be conditional; it skips itself in the script");
  assert.equal(step?.["continue-on-error"], undefined);
  assert.equal(
    step?.run?.trim(),
    CHANGELOG_CHECK_COMMAND,
    "the step is the invocation; the rule and its cases live in the script's own test",
  );
  // A typo in that path would otherwise only surface on a pull request.
  assert.ok(
    (await readFile(CHANGELOG_CHECK_SCRIPT, "utf8")).length > 0,
    `${CHANGELOG_CHECK_SCRIPT} must exist`,
  );
  assert.deepEqual(step?.env, {
    EVENT_NAME: "${{ github.event_name }}",
    GH_TOKEN: "${{ github.token }}",
    HEAD_IS_FORK: "${{ github.event.pull_request.head.repo.fork }}",
    PR_NUMBER: "${{ github.event.pull_request.number }}",
  });
  assert.doesNotMatch(
    JSON.stringify(step),
    /\$\{\{[^}]*\bsecrets\b/,
    "the changelog check must not read a configured secret; github.token is the default, unconfigured token",
  );
  assert.doesNotMatch(
    step?.run ?? "",
    /\$\{\{/u,
    "the run: script must read every event field through env:, never interpolate it directly",
  );
});

test("no CI step reads a pull request's file list through the capped gh pr view field", async () => {
  const source = await readFile(".github/workflows/ci.yml", "utf8");

  assert.doesNotMatch(
    source,
    /gh pr view[^\n]*--json[^\n]*\bfiles\b/u,
    "`gh pr view --json files` returns at most 100 files, never paginates, and says nothing when it truncates",
  );
});

test("the required check fails when any pull request dependency does not succeed", async () => {
  const jobs = await ciJobs();
  const aggregate = jobs.ci as CiJob;

  assert.deepEqual(
    [...(aggregate.needs ?? [])].sort(),
    [...REQUIRED_JOBS].sort(),
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
  assert.doesNotMatch(
    script,
    /\$\{\{[^}]*engine-canary-scope/u,
    "the scope job's result and outputs must reach the script through env:, not the script body",
  );
  const check = (aggregate.steps ?? []).find((step) => step.run);
  assert.equal(check?.env, undefined);
  assert.doesNotMatch(
    script,
    /engine-canary/u,
    "ci must not read the engine canary: it runs on demand and never gates a merge",
  );
  assert.match(script, /!=\s*"success"/, "the check must reject any non-success result");
  assert.match(script, /exit 1/, "the check must fail the job on a non-success result");
});

type RequiredJob = (typeof REQUIRED_JOBS)[number];

interface AggregateScenario {
  event?: string;
  fork?: string;
  results?: Partial<Record<RequiredJob, string>>;
}

/**
 * The aggregate's verdict for one set of dependency results, from its own
 * script run the way the runner runs it once GitHub has rendered the
 * expressions. An expression the scenario does not render fails the test
 * instead of rendering empty, so a new input cannot slip past these cases.
 */
async function aggregateVerdict(scenario: AggregateScenario): Promise<{
  green: boolean;
  output: string;
}> {
  const aggregate = (await ciJobs()).ci as CiJob;
  const needs = aggregate.needs ?? [];
  const results: Record<string, string> = {};
  for (const name of needs) {
    results[name] = scenario.results?.[name as RequiredJob] ?? "success";
  }
  const context: Record<string, string> = {
    "github.event_name": scenario.event ?? "pull_request",
    "github.event.pull_request.head.repo.fork": scenario.fork ?? "false",
    "join(needs.*.result, ' ')": needs.map((name) => results[name]).join(" "),
  };
  for (const name of needs) context[`needs.${name}.result`] = results[name]!;
  const render = (text: string) =>
    text.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_expression, inner: string) => {
      const value = context[inner];
      if (value === undefined) throw new Error(`unrendered expression: ${inner}`);
      return value;
    });

  let green = true;
  let output = "";
  for (const step of aggregate.steps ?? []) {
    if (!step.run) continue;
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const [name, value] of Object.entries(step.env ?? {})) {
      env[name] = render(value);
    }
    const run = spawnSync("bash", ["-c", render(step.run)], {
      encoding: "utf8",
      env,
    });
    output += `${run.stdout}${run.stderr}`;
    if (run.status !== 0) {
      green = false;
      break;
    }
  }
  return { green, output };
}

test("the required check is green exactly when every source job succeeded", async () => {
  const green = await aggregateVerdict({});
  assert.ok(green.green, `every source job green must leave ci green:\n${green.output}`);
  for (const event of ["pull_request", "push", "merge_group", "workflow_dispatch"]) {
    assert.ok((await aggregateVerdict({ event, fork: "" })).green, `a green ${event} run must stay green`);
  }
  for (const name of SOURCE_JOBS) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const verdict = await aggregateVerdict({ results: { [name]: result } });
      assert.equal(verdict.green, false, `${name} ${result} must turn ci red:\n${verdict.output}`);
      assert.match(verdict.output, new RegExp(`'${name}' reported '${result}'`, "u"));
    }
  }
});

test("the engine canary is its own on-demand workflow, and ci never waits for it", async () => {
  const jobs = await ciJobs();
  assert.equal(jobs["engine-canary"], undefined, "ci.yml must not carry the engine canary");
  assert.equal(jobs["engine-canary-scope"], undefined, "ci.yml must not carry the canary scope job");

  const workflow = await canaryWorkflow();
  // Started by a label on a pull request, or by hand: nothing else. A pull
  // request without the label starts no job and spends nothing.
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.pull_request?.types, ["labeled", "synchronize", "reopened"]);
  assert.deepEqual(workflow.on.workflow_dispatch?.inputs?.cases?.options, ["custom", "all"]);
  assert.equal(workflow.on.workflow_dispatch?.inputs?.cases?.default, "custom");

  const scope = workflow.jobs["engine-canary-scope"] as CiJob;
  const canary = workflow.jobs["engine-canary"] as CiJob;
  assert.equal(
    scope.if,
    "github.event_name == 'workflow_dispatch' || (github.event.pull_request.head.repo.full_name == github.repository && contains(github.event.pull_request.labels.*.name, 'run-canary') && (github.event.action != 'labeled' || github.event.label.name == 'run-canary'))",
  );
  assert.equal(scope.environment, undefined);
  assert.doesNotMatch(JSON.stringify(scope), /\bsecrets\./u);
  assert.equal(scope.needs, undefined);
  assert.equal(scope.concurrency, undefined, "the scope job must not join the fixtures queue");
  assert.deepEqual(canary.needs, ["engine-canary-scope"]);
  assert.equal(
    canary.if,
    "needs.engine-canary-scope.result == 'success' && needs.engine-canary-scope.outputs.migrations != 'true'",
  );
});

test("the engine canary fails closed when it runs, and runs one cheap case by default", async () => {
  const jobs = (await canaryWorkflow()).jobs;
  const scopeJob = jobs["engine-canary-scope"] as CiJob;
  const canary = jobs["engine-canary"] as CiJob;

  assert.equal(canary.environment, "e2e");
  // Up to three runs, their cleanup, and a sweep that may settle a stopped
  // predecessor for up to five minutes per fixture ticket.
  assert.equal(canary["timeout-minutes"], 95);
  // Repository-wide, not per pull request: the three fixture tickets are
  // shared, so two pull requests running at once would collide on them.
  // cancel-in-progress stays false so a second pull request queues instead
  // of cancelling or racing the first one's runs.
  assert.deepEqual(canary.concurrency, {
    group: "engine-canary-shared-fixtures",
    "cancel-in-progress": false,
  });

  // The scope job diffs the change against its base and hands the migration
  // answer to the canary job's condition.
  const scopeSteps = scopeJob.steps ?? [];
  const checkout = scopeSteps.find((step) => step.uses === "actions/checkout@v4");
  assert.equal(checkout?.with?.["fetch-depth"], 0);
  const scope = scopeSteps.find((step) => step.name === "Select engine canary scope");
  assert.match(scope?.run ?? "", /engine-canary-scope\.ts/u);
  assert.match(scope?.run ?? "", /--base "origin\/\$BASE_REF"/u);
  // Only the migration answer is handed on: the label, not the path list,
  // decides whether the canary runs.
  assert.deepEqual((scopeJob as { outputs?: unknown }).outputs, {
    migrations: "${{ steps.scope.outputs.migrations }}",
  });
  const migrationSkip = scopeSteps.find(
    (step) => step.name === "Skip pull request migrations",
  );
  assert.equal(
    migrationSkip?.if,
    "steps.scope.outputs.migrations == 'true'",
  );
  assert.match(migrationSkip?.run ?? "", /engine-canary skipped/u);
  assert.match(
    migrationSkip?.run ?? "",
    /the change carries a database migration; the canary target shares the production database, so it runs after merge only/u,
  );
  assert.match(migrationSkip?.run ?? "", /exit 0/u);
  assert.ok(
    scopeSteps.indexOf(scope!) < scopeSteps.indexOf(migrationSkip!),
    "the migration warning must follow the scope selection",
  );

  const steps = canary.steps ?? [];
  assert.ok(
    !steps.some((step) => step.name === "Select engine canary scope"),
    "the canary job must not select its own scope inside the shared queue",
  );
  const target = steps.find(
    (step) => step.name === "Validate engine canary target configuration",
  );
  // The job runs only when somebody asked for it, so the target check is unconditional.
  assert.equal(target?.if, undefined);
  assert.match(target?.run ?? "", /missing required names/u);
  assert.equal(
    target?.env?.ENGINE_CANARY_TARGET_URL,
    "${{ vars.ENGINE_CANARY_TARGET_URL }}",
  );
  assert.match(
    target?.run ?? "",
    /required=\([\s\S]*ENGINE_CANARY_TARGET_URL/u,
  );
  assert.match(target?.run ?? "", /value\.startsWith\("https:\/\/"\)/u);
  assert.match(target?.run ?? "", /value !== url\.origin/u);
  assert.match(
    target?.run ?? "",
    /url\.hostname === "ai-workflow-app-eight\.vercel\.app"/u,
  );
  assert.match(
    target?.run ?? "",
    /if \[ "\$ENGINE_CANARY_TARGET" = "production" \]; then\n\s+echo "::error title=engine-canary configuration::the Vercel production target is forbidden"\n\s+exit 1\n\s*fi/u,
  );
  // The job holds no production database credential: identity is proved
  // through /health alone, not by fingerprinting a connection string on the
  // runner.
  assert.equal(target?.env?.DATABASE_URL, undefined);
  assert.doesNotMatch(target?.run ?? "", /DATABASE_URL/u);

  const targetIndex = steps.findIndex((step) => step === target);
  const deployIndex = steps.findIndex(
    (step) => step.name === "Deploy engine canary target",
  );

  const preflight = steps.find(
    (step) => step.name === "Verify deployment and database identity",
  );
  assert.equal(
    preflight?.env?.URL,
    "${{ vars.ENGINE_CANARY_TARGET_URL }}",
  );
  assert.match(preflight?.run ?? "", /--target "\$ENGINE_CANARY_TARGET"/u);
  assert.match(preflight?.run ?? "", /deadline=\$\(\(SECONDS \+ 300\)\)/u);
  assert.match(preflight?.run ?? "", /sleep 10/u);
  assert.match(
    preflight?.run ?? "",
    /target alias did not report commit \$GITHUB_SHA within 5 minutes/u,
  );
  assert.equal(preflight?.env?.DATABASE_URL, undefined);
  assert.doesNotMatch(preflight?.run ?? "", /--database-url/u);
  assert.doesNotMatch(preflight?.run ?? "", /DATABASE_URL/u);
  const preflightIndex = steps.findIndex((step) => step === preflight);
  const canaries = steps.find(
    (step) => step.name === "Run engine canaries",
  );
  assert.equal(
    canaries?.env?.HARNESS_CANARY_BASE_URL,
    "${{ vars.ENGINE_CANARY_TARGET_URL }}",
  );
  assert.equal(canaries?.env?.DATABASE_URL, undefined);
  assert.doesNotMatch(canaries?.run ?? "", /DATABASE_URL/u);
  assert.equal(
    canaries?.env?.ENGINE_CANARY_LOG_SOURCE_URL,
    "${{ steps.deploy.outputs.url }}",
  );
  assert.equal(canaries?.env?.VERCEL_TOKEN, "${{ secrets.VERCEL_TOKEN }}");
  // The built-in Opus and Codex cases only when somebody asked for all three.
  assert.equal(
    canaries?.env?.ENGINE_CANARY_CASES,
    "${{ github.event_name == 'workflow_dispatch' && inputs.cases || 'custom' }}",
  );
  // The canary queries the runtime logs itself. A background follow stream
  // never settled, and its export never named the run.
  assert.doesNotMatch(String(canaries?.run), /vercel@\d|--follow/u);
  assert.ok(
    !steps.some(
      (step) => step.name === "Show the tail of the replay log export on failure",
    ),
    "the retired log export must have no tail step left behind",
  );
  for (const step of [target, canaries]) {
    for (const name of [
      "REPLAY_CANARY_LOG_WAIT_MS",
      "REPLAY_CANARY_LOG_MAX_BYTES",
    ]) {
      assert.equal(step?.env?.[name], `\${{ vars.${name} }}`);
    }
    for (const name of [
      "REPLAY_CANARY_LOG_EXPORT_PATH",
      "REPLAY_CANARY_LOG_SETTLE_MS",
    ]) {
      assert.equal(
        step?.env?.[name],
        undefined,
        `${name} is retired and must not stay in the engine canary env`,
      );
      assert.doesNotMatch(String(step?.run), new RegExp(name, "u"));
    }
  }
  assert.equal(
    canaries?.env?.HARNESS_CANARY_EXPECTED_HOST,
    "${{ steps.target.outputs.host }}",
  );
  const canariesIndex = steps.findIndex((step) => step === canaries);
  assert.ok(
    targetIndex < deployIndex &&
      deployIndex < preflightIndex &&
      preflightIndex < canariesIndex,
    "engine canary steps must preserve target validation, deploy, preflight, and canary order",
  );

  // There is no unarmed state left to guard against. An empty
  // ENGINE_CANARY_TARGET fails the target step and a failed step stops the job,
  // so a step carrying `if: steps.target.outputs.armed == 'true'` would be
  // describing a state this job can no longer reach, and an `armed=false`
  // output would be describing a green job that gated nothing.
  for (const step of steps) {
    assert.equal(
      step.if,
      undefined,
      `${step.name ?? step.run} must not be conditional: the job only starts when the canary was asked for, and an unconfigured target refuses`,
    );
  }
  assert.doesNotMatch(
    JSON.stringify(canary),
    /armed/u,
    "the retired armed flag must leave no output, guard or message behind",
  );
});

const CANARY_TARGET_STEP_NAME = "Validate engine canary target configuration";

/**
 * One complete, valid configuration for the target validation step, so a
 * scenario only has to name what it changes. Every env name the step declares
 * must appear here: a variable the step gains without a value would otherwise
 * reach the script empty and quietly turn every scenario into the missing-name
 * refusal.
 */
const TARGET_ENV: Record<string, string> = {
  ENGINE_CANARY_TARGET: "ai-workflow-demo",
  ENGINE_CANARY_TARGET_URL: "https://engine-canary.example.com",
  ENGINE_CANARY_DB_ENV: "production",
  ENGINE_CANARY_DB_FINGERPRINT: "fingerprint",
  VERCEL_TOKEN: "vercel-token",
  VERCEL_ORG_ID: "org",
  VERCEL_PROJECT_ID: "project",
  ENGINE_CANARY_MCP_CLIENT_ID: "client-id",
  ENGINE_CANARY_MCP_CLIENT_SECRET: "client-secret",
  VERCEL_AUTOMATION_BYPASS_SECRET: "bypass",
  NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED: "true",
  HARNESS_CANARY_TIMEOUT_MS: "600000",
  REPLAY_CANARY_LOG_WAIT_MS: "120000",
  REPLAY_CANARY_LOG_MAX_BYTES: "33554432",
};

/**
 * The target validation step's own `run:` block, executed the way the runner
 * executes it, with GITHUB_OUTPUT pointed at a temporary file. The block reads
 * every value through env:, so it runs here unmodified and its verdict is the
 * verdict the runner would reach.
 */
async function targetVerdict(overrides: Record<string, string>): Promise<{
  green: boolean;
  output: string;
  outputs: string;
}> {
  const canary = (await canaryWorkflow()).jobs["engine-canary"] as CiJob;
  const step = (canary.steps ?? []).find(
    (entry) => entry.name === CANARY_TARGET_STEP_NAME,
  );
  assert.ok(step?.run, `${CANARY_WORKFLOW} must carry the "${CANARY_TARGET_STEP_NAME}" step`);

  const directory = await mkdtemp(join(tmpdir(), "engine-canary-target-"));
  const outputPath = join(directory, "github-output");
  await writeFile(outputPath, "");

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GITHUB_OUTPUT: outputPath,
  };
  for (const name of Object.keys(step.env ?? {})) {
    const value = overrides[name] ?? TARGET_ENV[name];
    assert.notEqual(
      value,
      undefined,
      `TARGET_ENV must carry a value for ${name}, which the step declares`,
    );
    env[name] = value as string;
  }

  const run = spawnSync("bash", ["-c", step.run as string], {
    encoding: "utf8",
    env,
  });
  return {
    green: run.status === 0,
    output: `${run.stdout}${run.stderr}`,
    outputs: await readFile(outputPath, "utf8"),
  };
}

test("an unconfigured engine canary target refuses instead of reporting a green job", async () => {
  const configured = await targetVerdict({});
  assert.ok(
    configured.green,
    `a complete configuration must pass the target check:\n${configured.output}`,
  );
  assert.match(
    configured.outputs,
    /^host=engine-canary\.example\.com$/mu,
    "the target check must publish the host the canary asserts against",
  );

  // The job only starts for a same-repository pull request whose scope job
  // succeeded and said this change needs the canary, so an empty target is a
  // refusal. It used to warn and exit 0, which reported success for a job that
  // had run no behavioural gate, and `ci` counted that success.
  const empty = await targetVerdict({ ENGINE_CANARY_TARGET: "" });
  assert.equal(
    empty.green,
    false,
    `an empty ENGINE_CANARY_TARGET must fail the job:\n${empty.output}`,
  );
  assert.match(empty.output, /::error/u, "the refusal must be an error annotation");
  assert.doesNotMatch(
    empty.output,
    /::warning/u,
    "a warning inside a green job is the trace this refusal replaces",
  );
  assert.match(
    empty.output,
    /ENGINE_CANARY_TARGET/u,
    "the refusal must name the missing repository variable",
  );
  assert.match(
    empty.output,
    /the behavioural gate did not run and this job proves nothing/u,
    "the refusal must say plainly that nothing was proved",
  );
  assert.doesNotMatch(
    empty.outputs,
    /armed/u,
    "the refusal must write no step output that a later step could read as an idle state",
  );

  const production = await targetVerdict({ ENGINE_CANARY_TARGET: "production" });
  assert.equal(production.green, false);
  assert.match(production.output, /the Vercel production target is forbidden/u);

  const incomplete = await targetVerdict({ ENGINE_CANARY_DB_FINGERPRINT: "" });
  assert.equal(incomplete.green, false);
  assert.match(
    incomplete.output,
    /missing required names: ENGINE_CANARY_DB_FINGERPRINT/u,
  );
});

test("CI never uses pull_request_target", async () => {
  const source = await readFile(".github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(source, /\bpull_request_target\b/u);
});

test("every multiline CI run block starts in strict mode", async () => {
  const jobs = await ciJobs();
  let multilineRuns = 0;

  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.run?.includes("\n")) continue;
      multilineRuns += 1;
      assert.ok(
        step.run.startsWith("set -euo pipefail\n"),
        `${jobName}: ${step.name ?? "unnamed run"} must start with set -euo pipefail`,
      );
    }
  }

  assert.ok(multilineRuns > 0, "ci.yml must contain multiline run blocks");
});

test("every multiline changelog workflow run block starts in strict mode", async () => {
  const source = await readFile(".github/workflows/changelog.yml", "utf8");
  const workflow = parse(source) as { jobs: Record<string, CiJob> };
  let multilineRuns = 0;

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.run?.includes("\n")) continue;
      multilineRuns += 1;
      assert.ok(
        step.run.startsWith("set -euo pipefail\n"),
        `${jobName}: ${step.name ?? "unnamed run"} must start with set -euo pipefail`,
      );
    }
  }

  assert.ok(multilineRuns > 0, "changelog.yml must contain multiline run blocks");
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
    "tsx scripts/check-retired-env.ts",
    "pnpm validate:pre-sandbox",
    "pnpm validate:local-skills",
    "pnpm mcp:contract:check",
    "pnpm --dir ../.. run gen:blocks -- --check",
    "pnpm --dir ../.. run gen:integrations -- --check",
    "rm -rf .nitro/workflow",
    "NODE_OPTIONS=--max-old-space-size=8192 nitro build",
  ]);
  assert.equal(
    dashboardPackage.scripts.build,
    "tsx ../../scripts/gates/generate-block-catalog.ts --check && tsx ../../scripts/gates/generate-integration-registry.ts --check && next build",
  );
  assert.doesNotMatch(workerPackage.scripts["build:ci"], /db:migrate/);
  assert.doesNotMatch(workerPackage.scripts["build:ci"], /seed:auth-user/);
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
  // The production build writes to the database before it compiles, so every
  // check that can refuse the commit has to run first: a check that fails after
  // `db:migrate` leaves production on a new schema with the old code serving.
  // Held as what follows the first write, exactly, so a check added after it
  // fails here whatever it is called; before it, the order is free.
  const build = commands(workerPackage.scripts.build);
  const firstWrite = build.indexOf("pnpm db:migrate");
  assert.ok(firstWrite > 0, "the worker build migrates, after its checks");
  assert.deepEqual(build.slice(firstWrite), [
    "pnpm db:migrate",
    "pnpm seed:auth-user",
    "rm -rf .nitro/workflow",
    "NODE_OPTIONS=--max-old-space-size=8192 nitro build",
  ]);
  for (const command of [
    "tsx scripts/check-retired-env.ts",
    "pnpm validate:pre-sandbox",
    "pnpm validate:local-skills",
    "pnpm --dir ../.. run gen:blocks -- --check",
    "pnpm --dir ../.. run gen:integrations -- --check",
  ]) {
    assert.ok(build.slice(0, firstWrite).includes(command), `the worker build runs ${command} before it writes to the database`);
  }
});

test("all setup-node workflow jobs use Node 24", async () => {
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/e2e.yml",
    ".github/workflows/engine-canary.yml",
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

  // Four source jobs in ci.yml (the `ci` aggregate installs nothing), three
  // e2e tiers in e2e.yml, and the canary scope and the canary in
  // engine-canary.yml. The count is pinned so a new job cannot quietly join
  // on an older Node; it dropped from ten when the three e2e tiers duplicated
  // into ci.yml behind an unreachable `merge_group` were removed.
  assert.equal(
    setupNodeJobs,
    9,
    `expected 9 setup-node jobs across CI workflows, found ${setupNodeJobs}`,
  );
});
