import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export type Cmd = readonly [string, ...string[]];
export type Git = (args: readonly string[]) => Promise<Buffer>;
export type Repo = {
  exists(path: string): boolean;
  list(directory: string): readonly string[];
};
export type PlanStatus = "NOOP" | "READY" | "INVALID_SCOPE";
export type Plan = {
  status: PlanStatus;
  scopes: string[];
  commands: Cmd[];
  errors: string[];
};

export const WORKFLOW_TESTS = [
  "src/engine/step-registration-coverage.test.ts",
  "src/engine/tests/block-executors.test.ts",
  "src/engine/definition/block-registry.test.ts",
] as const;

/**
 * A change under packages/workflow-graph moves rules the worker bundles, so it
 * plans the guards that prove the step files and the import graph still hold,
 * then the worker suites that import the package. Later stages of the workflow
 * graph plan add their moved suites to the second group.
 */
export const WORKFLOW_GRAPH_TESTS = [
  "src/engine/workflow-import-boundary.test.ts",
  "src/routes/import-graph-guard.test.ts",
  "src/mcp/tool-catalog.test.ts",
  "src/engine/definition/__golden__/definition-deployment-issues.test.ts",
  "src/engine/definition/schema-v2.test.ts",
  "src/engine/execution-error-invariant.test.ts",
  "src/workflow-graph-suites/available-values.test.ts",
  "src/workflow-graph-suites/bindings.test.ts",
  "src/workflow-graph-suites/failure-message.test.ts",
  "src/workflow-graph-suites/invocation-context.test.ts",
  "src/workflow-graph-suites/json-schema-authoring.test.ts",
  "src/workflow-graph-suites/scenarios/scheduling-golden.test.ts",
  "src/workflow-graph-suites/transform.test.ts",
  "src/workflow-graph-suites/v2-bindings.test.ts",
  "src/workflow-graph-suites/v2-branch.test.ts",
  "src/workflow-graph-suites/v2-scheduler.test.ts",
  "src/workflow-graph-suites/value-analysis-pass.test.ts",
  "src/workflow-graph-suites/workspace-access.test.ts",
] as const;

/**
 * The worker's side of the seam with @integrations/sdk: the port files that
 * re-export the SDK and the DevKit behaviour the SDK's FatalError relies on.
 * A change under integrations/ plans them, since the SDK's own suites cannot
 * see the worker.
 */
export const INTEGRATION_SDK_SEAM_TESTS = [
  "src/adapters/issue-tracker/types.test.ts",
  "src/adapters/vcs/types.test.ts",
] as const;

/**
 * The committed fingerprint of every shipped integration's connection fields.
 * A manifest is the only place a connection field's key, env, secret or
 * default lives, so this is the one test a manifest edit can go stale
 * against without a diagnostic saying so (see the test's own comment). A
 * change to a manifest anywhere under integrations/ plans it.
 */
export const CONNECTION_SHAPE_TEST = [
  "src/services/integrations/connection-shape.test.ts",
] as const;

/**
 * The committed prompts every agent receives. A file that composes a prompt
 * moves them without a test of its own going red, so a change to any of those
 * files plans the golden and the oracle that compare the result byte for byte.
 */
export const PROMPT_ORACLE_TESTS = [
  "src/test-support/prompt-oracle/golden.test.ts",
  "src/test-support/prompt-oracle/oracle.test.ts",
] as const;

/** The files the prompt oracle composes its prompts from. */
const PROMPT_SOURCES = new Set([
  "apps/worker/src/sandbox/context.ts",
  "apps/worker/src/engine/helpers/effective-prompt.ts",
  "apps/worker/src/engine/repository-discovery/runner.ts",
  "apps/worker/src/engine/blocks/generic-agent/execute.ts",
]);

export const WORKTREE_DIFF =["git", "diff", "--check"] as const satisfies Cmd;
export const STAGED_WORKTREE_DIFF = ["git", "diff", "--cached", "--check"] as const satisfies Cmd;
export const candidateDiff = (merge: string, candidate: string): Cmd =>
  ["git", "diff", "--check", merge, candidate, "--"];
export const namesDiff = (merge: string, candidate: string): Cmd => [
  "git", "diff", "--name-only", "-z", "--no-renames", merge, candidate, "--",
];
export const stagedNamesDiff = (): Cmd => [
  "git", "diff", "--cached", "--name-only", "-z", "--no-renames", "--",
];
export const worktreeNamesDiff = (merge: string, candidate: string): readonly Cmd[] => [
  namesDiff(merge, candidate),
  stagedNamesDiff(),
  ["git", "diff", "--name-only", "-z", "--no-renames", "--"],
  ["git", "ls-files", "--others", "--exclude-standard", "-z", "--"],
];

const C = {
  rootType: ["pnpm", "run", "typecheck"],
  workerType: ["pnpm", "--filter", "worker", "run", "typecheck"],
  dashboardType: ["pnpm", "--filter", "ai-workflow-dashboard", "run", "typecheck"],
  preSandbox: ["pnpm", "--dir", "apps/worker", "run", "validate:pre-sandbox"],
  skills: ["pnpm", "--dir", "apps/worker", "run", "validate:local-skills"],
  mcp: ["pnpm", "--dir", "apps/worker", "run", "mcp:contract:check"],
  mcpZod4: ["pnpm", "--dir", "apps/worker", "run", "test:zod4"],
  blockCatalog: ["pnpm", "run", "gen:blocks", "--check"],
  integrationRegistry: ["pnpm", "run", "gen:integrations", "--check"],
  ci: ["pnpm", "run", "test:ci"],
  workflowSdk: ["pnpm", "run", "test:workflow-sdk"],
  packages: ["pnpm", "run", "test:packages"],
  packagesZod4: ["pnpm", "run", "test:packages:zod4"],
  workflowGraphZod4: ["pnpm", "--filter", "@shared/workflow-graph", "run", "test:zod4"],
  releaseType: ["pnpm", "run", "typecheck:release-notes"],
  releaseTest: ["pnpm", "run", "test:release-notes"],
  gates: ["pnpm", "run", "gates"],
  docsStatus: ["pnpm", "run", "gate:docs-status"],
} as const satisfies Record<string, Cmd>;

const ROOT_CI = new Set([
  ".gitattributes",
  ".gitignore",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);
const ROOT_TYPE = new Set(["package.json", "pnpm-lock.yaml"]);
const GATE_CONFIG = new Set([
  ".dependency-cruiser.cjs",
  ".oxlintrc.json",
  "knip.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".gitattributes",
  ".gitignore",
]);
const RELEASE_WORKFLOWS = new Set([
  ".github/workflows/prepare-artur-release.yml",
  ".github/workflows/sync-artur-release.yml",
  ".github/workflows/release-artur.yml",
]);
const FIXED_TESTS = new Set<string>([
  ...WORKFLOW_TESTS,
  ...WORKFLOW_GRAPH_TESTS,
  ...INTEGRATION_SDK_SEAM_TESTS,
  ...CONNECTION_SHAPE_TEST,
]);
const TEST = /\.(?:test|spec)\.tsx?$/;
export function listDirectory(
  directory: string,
  read: typeof readdirSync = readdirSync,
): string[] {
  try {
    return read(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}
const disk: Repo = {
  exists: existsSync,
  list: listDirectory,
};

const any = (paths: readonly string[], match: (path: string) => boolean) =>
  paths.some(match);
const isDocs = (path: string) =>
  path.startsWith("docs/") ||
  // A committed golden is a test fixture, not prose: a hand edit to one must
  // plan the test that compares against it.
  (/\.(?:md|mdx|txt)$/i.test(path) && !path.includes("/__golden__/")) ||
  path === ".claude/settings.json" ||
  path.startsWith(".claude/rules/") ||
  path.startsWith(".claude/skills/") ||
  path === "AGENTS.md" ||
  path.endsWith("/AGENTS.md") ||
  path === "CLAUDE.md" ||
  path.endsWith("/CLAUDE.md");
const isSkill = (path: string) => path.startsWith("skills/");
const isRelease = (path: string) =>
  path.startsWith("scripts/release-notes/") ||
  path.startsWith("docs/releases/") ||
  RELEASE_WORKFLOWS.has(path);
const isCi = (path: string) =>
  path.startsWith(".github/") ||
  path.startsWith(".githooks/") ||
  path.startsWith("scripts/ci/") ||
  // test:ci runs the changelog and release scripts' tests as well.
  path.startsWith("scripts/changelog/") ||
  // A gate's own tests live under scripts/ci/, so editing a gate without
  // running them is how a gate stops testing what it says it tests.
  path.startsWith("scripts/gates/") ||
  path.startsWith(".claude/hooks/") ||
  path === ".claude/context-budget.tsv" ||
  path.startsWith(".codex/") ||
  ROOT_CI.has(path);
const isIntegration = (path: string) => path.startsWith("integrations/");
const isIntegrationManifest = (path: string) =>
  isIntegration(path) && path.endsWith("/manifest.ts");
const isPromptSource = (path: string) =>
  PROMPT_SOURCES.has(path) ||
  (path.startsWith("packages/prompts/") && !isDocs(path)) ||
  path.startsWith("apps/worker/src/test-support/prompt-oracle/");
const isWorkflowGraph = (path: string) =>
  path.startsWith("packages/workflow-graph/");
const isProduct = (path: string) =>
  path.startsWith("apps/worker/src/engine/") ||
  path.startsWith("apps/worker/src/services/workflow-definitions/") ||
  path.startsWith("apps/worker/src/workflow-graph-suites/") ||
  path.startsWith("apps/worker/src/sandbox/agents/fixtures/") ||
  path.startsWith("apps/worker/workflow-test-fixtures/") ||
  path.startsWith("packages/contracts/") ||
  isWorkflowGraph(path) ||
  path === "packages/contracts/block-catalog.generated.ts" ||
  path === "apps/worker/src/engine/blocks/executors.generated.ts" ||
  path === "apps/worker/vitest.config.ts";

/**
 * The workflow-sdk suite is the only one that builds the fixtures through the
 * Workflow builder and then loads the emitted bundles in Node, so it is the
 * only place that proves a `@shared/*` package reached from a step is still
 * loadable there. Nothing else plans it: `discoveredTests` skips
 * `workflow-sdk-tests/` on purpose, so the paths whose contents decide what
 * those bundles contain name it here. The divergence suite under
 * `workflow-sdk-tests/divergence/` stays out of every pull request's budget and
 * is excluded.
 */
const isWorkflowSdkSubject = (path: string) =>
  isWorkflowGraph(path) ||
  path === "apps/worker/src/engine/agent-workflow.ts" ||
  path.startsWith("apps/worker/src/engine/helpers/") ||
  path.startsWith("apps/worker/workflow-test-fixtures/") ||
  (path.startsWith("apps/worker/workflow-sdk-tests/") &&
    !path.startsWith("apps/worker/workflow-sdk-tests/divergence/"));

/**
 * What decides the integration registries: any integration package, and the
 * generator and registry files themselves. A change to one of them without a
 * regeneration is a stale registry, which is what `--check` catches.
 */
const isIntegrationRegistrySource = (path: string) =>
  isIntegration(path) ||
  path === "scripts/gates/generate-integration-registry.ts" ||
  path.startsWith("scripts/gates/generate-integration-registry/");

const isBlockCatalogSource = (path: string) =>
  path.startsWith("apps/worker/src/engine/blocks/") ||
  path.startsWith("apps/worker/src/engine/definition/") ||
  path === "scripts/gates/generate-block-catalog.ts" ||
  path === "packages/contracts/block-catalog.generated.ts" ||
  path === "apps/worker/src/engine/blocks/executors.generated.ts";

const isKnownPath = (path: string) =>
  isDocs(path) ||
  isSkill(path) ||
  isRelease(path) ||
  isCi(path) ||
  path.startsWith("apps/worker/") ||
  path.startsWith("apps/dashboard/") ||
  path.startsWith("packages/") ||
  isIntegration(path) ||
  path.startsWith("scripts/") ||
  ROOT_TYPE.has(path) ||
  GATE_CONFIG.has(path);

function discoveredTests(path: string, repo: Repo): string[] {
  if (TEST.test(path)) return repo.exists(path) ? [path] : [];
  if (!/\.tsx?$/.test(path)) return [];
  const directory = dirname(path);
  const stem = basename(path).replace(/\.tsx?$/, "");
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}(?:\\..+)?\\.(?:test|spec)\\.tsx?$`);
  return [...repo.list(directory)]
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => `${directory}/${name}`)
    .filter(repo.exists);
}

/**
 * `node --test` reads every positional as a glob, so a Next dynamic segment
 * such as `[userId]` arrives as a character class and matches nothing: the run
 * collects zero files, reports zero tests and exits green. Node's glob has no
 * backslash escape, so each magic character is wrapped in a class of its own,
 * which is the form it does understand.
 */
const globLiteral = (path: string): string => path.replace(/[?*()[\]{}]/g, "[$&]");

export function plan(paths: readonly string[], repo: Repo = disk): Plan {
  if (paths.length === 0) {
    return { status: "NOOP", scopes: ["none"], commands: [], errors: [] };
  }
  const product = any(paths, isProduct);
  const skills = any(paths, isSkill);
  const release = any(paths, isRelease);
  const ci = any(paths, (path) => isCi(path) && !isDocs(path));
  const unknown = paths.filter((path) => !isKnownPath(path));
  const errors = unknown.length > 0
    ? [`No verification scope is defined for changed path(s): ${unknown.join(", ")}.`]
    : [];
  const hasFunctionalScope =
    skills ||
    release ||
    ci ||
    product ||
    paths.some((path) =>
      !isDocs(path) &&
      (path.startsWith("apps/") ||
        path.startsWith("packages/") ||
        isIntegration(path) ||
        path.startsWith("scripts/")),
    ) ||
    any(paths, (path) => GATE_CONFIG.has(path));
  if (paths.every(isDocs) && !hasFunctionalScope && errors.length === 0) {
    return { status: "READY", scopes: ["docs-only"], commands: [C.docsStatus], errors };
  }

  const worker = any(paths, (path) => path.startsWith("apps/worker/") && !isDocs(path));
  const dashboard = any(paths, (path) => path.startsWith("apps/dashboard/") && !isDocs(path));
  const shared = any(paths, (path) => path.startsWith("packages/") && !isDocs(path));
  const integrations = any(paths, (path) => isIntegration(path) && !isDocs(path));
  const integrationManifest = any(paths, isIntegrationManifest);
  const workflowSdk = any(paths, isWorkflowSdkSubject);
  const blockCatalog = any(paths, isBlockCatalogSource);
  const integrationRegistry = any(paths, isIntegrationRegistrySource);
  const gates = any(paths, (path) =>
    isProduct(path) ||
    (!isDocs(path) &&
      (path.startsWith("apps/") ||
        path.startsWith("packages/") ||
        isIntegration(path) ||
        path.startsWith("scripts/"))) ||
    GATE_CONFIG.has(path),
  );
  const rootType = any(paths, (path) => ROOT_TYPE.has(path));
  const workerBaseline = worker || product;
  const workerTests = new Set<string>([
    ...(product ? WORKFLOW_TESTS : []),
    ...(any(paths, isWorkflowGraph) ? WORKFLOW_GRAPH_TESTS : []),
    ...(integrations ? INTEGRATION_SDK_SEAM_TESTS : []),
    ...(integrationManifest ? CONNECTION_SHAPE_TEST : []),
    ...(any(paths, isPromptSource) ? PROMPT_ORACLE_TESTS : []),
  ]);
  const dashboardTests = new Set<string>();
  const docs = any(paths, (path) => isDocs(path) && !isSkill(path) && !isRelease(path));

  for (const path of paths) {
    if (!path.startsWith("apps/worker/") && !path.startsWith("apps/dashboard/")) {
      continue;
    }
    for (const found of discoveredTests(path, repo)) {
      if (
        found.startsWith("apps/worker/") &&
        !found.startsWith("apps/worker/e2e/") &&
        !found.startsWith("apps/worker/workflow-sdk-tests/")
      ) {
        workerTests.add(found.slice("apps/worker/".length));
      } else if (found.startsWith("apps/dashboard/")) {
        dashboardTests.add(found.slice("apps/dashboard/".length));
      }
    }
  }

  const scopes = [rootType && "root-package-or-lock", worker && "worker",
    dashboard && "dashboard", shared && "shared", integrations && "integrations",
    product && "product-workflow",
    ci && "ci", release && "release-notes", skills && "skills",
    gates && "gates",
    workerTests.size > 0 && "worker-tests", dashboardTests.size > 0 && "dashboard-tests",
    workflowSdk && "workflow-sdk",
    integrationRegistry && "integration-registry",
  ].filter((scope): scope is string => Boolean(scope));
  const commands: Cmd[] = [];
  const seen = new Set<string>();
  const add = (cmd: Cmd) => {
    const key = JSON.stringify(cmd);
    if (!seen.has(key)) {
      seen.add(key);
      commands.push(cmd);
    }
  };

  if (rootType || shared || integrations) add(C.rootType);
  else {
    if (workerBaseline) add(C.workerType);
    if (dashboard) add(C.dashboardType);
  }
  if (workerBaseline) {
    add(C.preSandbox);
    add(C.skills);
    add(C.mcp);
    add(C.mcpZod4);
  } else if (skills) add(C.skills);
  if (release) {
    add(C.releaseType);
    add(C.releaseTest);
  }
  if (ci) add(C.ci);
  if (docs) add(C.docsStatus);
  if (workerTests.size > 0) {
    const args = [...workerTests].map((path) =>
      FIXED_TESTS.has(path) ? path : `./${path}`,
    );
    add(["pnpm", "--dir", "apps/worker", "exec", "vitest", "run", ...args]);
  }
  if (workflowSdk) add(C.workflowSdk);
  if (blockCatalog) add(C.blockCatalog);
  if (integrationRegistry) add(C.integrationRegistry);
  if (dashboardTests.size > 0) {
    add([
      "pnpm",
      "--dir",
      "apps/dashboard",
      "exec",
      "node",
      "--experimental-test-module-mocks",
      "--import",
      "tsx",
      "--test",
      ...[...dashboardTests].map((path) => globLiteral(`./${path}`)),
    ]);
  }
  // Nothing else runs a package's own tests: the worker vitest run and the
  // dashboard node runner never reach packages/* or integrations/*. The zod 4
  // pass runs the same files again against the zod the worker bundle resolves,
  // which is not the one the workspace pins.
  if (shared || integrations) {
    add(C.packages);
    add(C.packagesZod4);
    if (any(paths, isWorkflowGraph)) add(C.workflowGraphZod4);
  }
  if (gates) add(C.gates);
  if (errors.length > 0) scopes.push("unclassified");
  return {
    status: errors.length > 0 ? "INVALID_SCOPE" : "READY",
    scopes: scopes.length > 0 ? scopes : ["unclassified"],
    commands,
    errors,
  };
}

const fullSha = (output: Buffer, label: string) => {
  const value = output.toString().trim();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} is not a full SHA.`);
  return value;
};

const errorCode = (error: unknown): string | number | undefined => {
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    if (!candidate || typeof candidate !== "object") continue;
    const code = (candidate as { code?: string | number; status?: number }).code;
    if (typeof code === "string" || typeof code === "number") return code;
    const status = (candidate as { status?: number }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isMissingReference = (error: unknown) =>
  errorCode(error) === 128 &&
  /ambiguous argument|needed a single revision|unknown revision|not a valid object name|no such ref|no upstream configured/iu.test(
    errorMessage(error),
  );

async function ref(git: Git, name: string): Promise<string | null> {
  try {
    return fullSha(
      await git(["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`]),
      name,
    );
  } catch (error) {
    if (isMissingReference(error)) return null;
    throw error;
  }
}

const isNoMergeBase = (error: unknown) => errorCode(error) === 1;

export async function resolveBase(git: Git, explicit?: string) {
  const candidateSha = await ref(git, "HEAD");
  if (!candidateSha) throw new Error("HEAD does not resolve to a local commit.");
  const choices = explicit
    ? [["explicit", explicit] as const]
    : ([
        ["upstream", "@{upstream}"],
        ["origin/HEAD", "origin/HEAD"],
        ["origin/main", "origin/main"],
      ] as const);
  for (const [source, reference] of choices) {
    const baseSha = await ref(git, reference);
    if (!baseSha) continue;
    try {
      const mergeBaseSha = fullSha(
        await git(["merge-base", baseSha, candidateSha]),
        "merge-base",
      );
      return { source, reference, baseSha, candidateSha, mergeBaseSha };
    } catch (error) {
      if (!isNoMergeBase(error)) {
        throw new Error(
          `Could not compute merge-base for ${reference}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      throw new Error(
        `No merge-base for ${reference}; pass the intended local ref with --base <ref>.`,
        { cause: error },
      );
    }
  }
  const tried = explicit ? `--base ${JSON.stringify(explicit)}` : "the local base refs";
  throw new Error(
    `Could not resolve ${tried}; pass a local ref or SHA with --base <ref>. This command never fetches.`,
  );
}

export async function assertCandidate(git: Git, expected: string, phase: string) {
  const actual = await ref(git, "HEAD");
  if (!actual) {
    throw new Error(`HEAD no longer resolves during ${phase}; rerun verification.`);
  }
  if (actual !== expected) {
    throw new Error(
      `Candidate moved during ${phase}: expected ${expected}, found ${actual}; rerun verification.`,
    );
  }
}

export const parseNames = (output: Buffer) =>
  output.toString().split("\0").filter(Boolean);
export const show = (cmd: Cmd) =>
  cmd.map((arg) => (/^[\w./:@{}+=,-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");

function capture([program, ...args]: Cmd): Promise<Buffer> {
  return new Promise((ok, fail) =>
    execFile(
      program,
      args,
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) =>
        error
          ? fail(
              new Error(
                `${show([program, ...args])} failed: ${stderr.toString().trim() || error.message}`,
                { cause: error },
              ),
            )
          : ok(stdout),
    ),
  );
}
function execute([program, ...args]: Cmd): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(program, args, { stdio: "inherit", shell: false });
    child.once("error", (error) =>
      fail(new Error(`${show([program, ...args])} failed to start: ${errorMessage(error)}`, { cause: error })),
    );
    child.once("exit", (code, signal) =>
      code === 0
        ? ok()
        : fail(new Error(`${show([program, ...args])} failed: ${signal ?? code}`)),
    );
  });
}

/**
 * Runs the planned commands in order and stops at the first failure. Each one
 * is echoed with its position in the plan before it starts, so a run that is
 * killed still shows how far it got, and a failure names the command that
 * failed plus every command after it that never started. The tail says those
 * are unproven in as many words, because the danger this output exists to
 * remove is a reader taking a command that never ran for one that passed.
 */
export async function runPlanned(
  commands: readonly Cmd[],
  run: (cmd: Cmd) => Promise<void> = execute,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  for (const [index, cmd] of commands.entries()) {
    const position = `${index + 1}/${commands.length}`;
    log(`[verify:changed] ${position} $ ${show(cmd)}`);
    try {
      await run(cmd);
    } catch (error) {
      const skipped = commands.slice(index + 1);
      log(`[verify:changed] FAILED ${position}: ${show(cmd)}`);
      log(
        skipped.length === 0
          ? "[verify:changed] NOT RUN: none, the failure was the last command in the plan."
          : [
              `[verify:changed] NOT RUN: ${skipped.length} command${skipped.length === 1 ? "" : "s"} after the failure never started. They are unproven, not passed.`,
              ...skipped.map(
                (later, offset) =>
                  `  ${index + 2 + offset}/${commands.length} $ ${show(later)}`,
              ),
            ].join("\n"),
      );
      throw new Error(
        `${position} ${show(cmd)} failed: ${error instanceof Error ? error.message : error}`,
        { cause: error },
      );
    }
  }
}

export function parseArgs(input: readonly string[]): string | undefined {
  return parseOptions(input).base;
}

export type VerifyOptions = { base?: string; worktree: boolean };

export function parseOptions(input: readonly string[]): VerifyOptions {
  const args = input[0] === "--" ? input.slice(1) : [...input];
  let base: string | undefined;
  let worktree = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--worktree") {
      if (worktree) throw new Error("Provide --worktree at most once.");
      worktree = true;
      continue;
    }
    const value = arg === "--base" ? args[++i] : arg.startsWith("--base=") ? arg.slice(7) : null;
    if (value === null) throw new Error(`Unknown argument ${JSON.stringify(arg)}.`);
    if (!value || base) throw new Error("Provide --base exactly once with a value.");
    base = value;
  }
  return { base, worktree };
}

export async function main(input = process.argv.slice(2)) {
  console.log(`[verify:changed] $ ${show(WORKTREE_DIFF)}`);
  await execute(WORKTREE_DIFF);
  const options = parseOptions(input);
  if (options.worktree) {
    console.log(`[verify:changed] $ ${show(STAGED_WORKTREE_DIFF)}`);
    await execute(STAGED_WORKTREE_DIFF);
  }
  const git: Git = (args) => capture(["git", ...args]);
  const resolved = await resolveBase(git, options.base);
  console.log(
    `[verify:changed] base: ${resolved.source} ${resolved.reference} -> ${resolved.baseSha}`,
  );
  console.log(`[verify:changed] candidate: HEAD -> ${resolved.candidateSha}`);
  console.log(`[verify:changed] merge-base: ${resolved.mergeBaseSha}`);
  await assertCandidate(git, resolved.candidateSha, "before candidate diff");
  const checks = candidateDiff(resolved.mergeBaseSha, resolved.candidateSha);
  console.log(`[verify:changed] $ ${show(checks)}`);
  await execute(checks);
  await assertCandidate(git, resolved.candidateSha, "before changed-path scan");
  const names = options.worktree
    ? worktreeNamesDiff(resolved.mergeBaseSha, resolved.candidateSha)
    : [namesDiff(resolved.mergeBaseSha, resolved.candidateSha)];
  for (const command of names) console.log(`[verify:changed] $ ${show(command)}`);
  const paths = [
    ...new Set(
      (await Promise.all(names.map((command) => capture(command)))).flatMap((output) => parseNames(output)),
    ),
  ];
  await assertCandidate(git, resolved.candidateSha, "after changed-path scan");
  const next = plan(paths);
  console.log(`[verify:changed] changed files: ${JSON.stringify(paths)}`);
  console.log(`[verify:changed] scopes: ${next.scopes.join(", ")}`);
  console.log(`[verify:changed] result: ${next.status}`);
  if (next.errors.length > 0) {
    throw new Error(next.errors.join(" "));
  }
  if (next.status === "NOOP") {
    await assertCandidate(git, resolved.candidateSha, "before no-op result");
    console.log("[verify:changed] NOOP: no changed paths; no scoped checks executed.");
    return;
  }
  console.log(
    next.commands.length > 0
      ? `[verify:changed] commands:\n${next.commands.map((cmd) => `  $ ${show(cmd)}`).join("\n")}`
      : "[verify:changed] commands: none (diff checks only)",
  );
  await assertCandidate(git, resolved.candidateSha, "before planned checks");
  await runPlanned(
    next.commands,
    async (command) => {
      await assertCandidate(git, resolved.candidateSha, `before ${show(command)}`);
      await execute(command);
      await assertCandidate(git, resolved.candidateSha, `after ${show(command)}`);
    },
  );
  await assertCandidate(git, resolved.candidateSha, "after planned checks");
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(`[verify:changed] FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
