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

test("the CI job runs the no-secret production build after its contract tests", async () => {
  const source = await readFile(".github/workflows/ci.yml", "utf8");
  const workflow = parse(source) as {
    jobs: {
      ci: {
        "continue-on-error"?: boolean;
        env?: Record<string, string>;
        environment?: unknown;
        if?: string;
        "timeout-minutes": number;
        steps: Array<{
          "continue-on-error"?: boolean;
          env?: Record<string, string>;
          if?: string;
          run?: string;
          uses?: string;
        }>;
      };
    };
  };
  const runSteps = workflow.jobs.ci.steps.filter(
    (step): step is { if?: string; run: string } => typeof step.run === "string",
  );

  assert.deepEqual(
    runSteps.map((step) => step.run),
    [
      "pnpm install --frozen-lockfile",
      "pnpm run typecheck",
      "pnpm run test",
      "pnpm run test:release-notes",
      "pnpm run test:ci",
      "pnpm run build:ci",
      "pnpm run test:workflow-sdk",
    ],
  );
  assert.equal(workflow.jobs.ci.if, undefined);
  assert.equal(workflow.jobs.ci["continue-on-error"], undefined);
  assert.equal(workflow.jobs.ci["timeout-minutes"], 60);
  assert.equal(
    workflow.jobs.ci.steps.every(
      (step) => step.if === undefined && step["continue-on-error"] === undefined,
    ),
    true,
  );
  assert.equal(runSteps[5]?.env, undefined);
  assert.equal(workflow.jobs.ci.environment, undefined);
  assert.equal(workflow.jobs.ci.env, undefined);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.ci), /\$\{\{[^}]*\bsecrets\b/);
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
    "pnpm build:shared",
    "pnpm validate:pre-sandbox",
    "pnpm validate:local-skills",
    "pnpm mcp:contract:check",
    "rm -rf .nitro/workflow",
    "NODE_OPTIONS=--max-old-space-size=8192 nitro build",
  ]);
  assert.equal(dashboardPackage.scripts.build, "pnpm build:shared && next build");
  assert.doesNotMatch(workerPackage.scripts["build:ci"], /db:migrate/);
  assert.doesNotMatch(workerPackage.scripts["build:ci"], /seed:auth-user/);
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
    "pnpm build:shared",
    "pnpm validate:pre-sandbox",
    "pnpm validate:local-skills",
    "pnpm db:migrate",
    "pnpm seed:auth-user",
    "rm -rf .nitro/workflow",
    "NODE_OPTIONS=--max-old-space-size=8192 nitro build",
  ]);
});
