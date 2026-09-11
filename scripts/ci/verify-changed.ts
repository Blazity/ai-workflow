import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Cmd = readonly [string, ...string[]];
export type Git = (args: readonly string[]) => Promise<Buffer>;
export type Repo = {
  exists(path: string): boolean;
  list(directory: string): readonly string[];
};
export type Plan = { scopes: string[]; commands: Cmd[] };

export const WORKFLOW_TESTS = [
  "src/engine/step-registration-coverage.test.ts",
  "src/engine/tests/block-executors.test.ts",
  "src/workflow-definition/block-registry.test.ts",
] as const;

export const WORKTREE_DIFF = ["git", "diff", "--check"] as const satisfies Cmd;
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
  blockCatalog: ["pnpm", "run", "gen:blocks", "--check"],
  ci: ["pnpm", "run", "test:ci"],
  packages: ["pnpm", "run", "test:packages"],
  releaseType: ["pnpm", "run", "typecheck:release-notes"],
  releaseTest: ["pnpm", "run", "test:release-notes"],
  gates: ["pnpm", "run", "gates"],
  docsStatus: ["pnpm", "run", "gate:docs-status"],
} as const satisfies Record<string, Cmd>;

const ROOT_CI = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const ROOT_TYPE = new Set(["package.json", "pnpm-lock.yaml"]);
const GATE_CONFIG = new Set([
  ".dependency-cruiser.cjs",
  ".oxlintrc.json",
  "knip.json",
  "package.json",
  "pnpm-lock.yaml",
]);
const RELEASE_WORKFLOWS = new Set([
  ".github/workflows/prepare-artur-release.yml",
  ".github/workflows/sync-artur-release.yml",
  ".github/workflows/release-artur.yml",
]);
const FIXED_TESTS = new Set<string>(WORKFLOW_TESTS);
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
  /\.(?:md|mdx|txt)$/i.test(path) ||
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
  ROOT_CI.has(path);
const isProduct = (path: string) =>
  path.startsWith("apps/worker/src/engine/") ||
  path.startsWith("apps/worker/src/workflow-definition/") ||
  path.startsWith("apps/worker/src/sandbox/agents/fixtures/") ||
  path.startsWith("apps/worker/workflow-test-fixtures/") ||
  path.startsWith("packages/contracts/") ||
  path === "packages/contracts/block-catalog.generated.ts" ||
  path === "apps/worker/src/engine/blocks/executors.generated.ts" ||
  path === "apps/worker/vitest.config.ts";

const isBlockCatalogSource = (path: string) =>
  path.startsWith("apps/worker/src/engine/blocks/") ||
  path.startsWith("apps/worker/src/engine/definition/") ||
  path === "scripts/gates/generate-block-catalog.ts" ||
  path === "packages/contracts/block-catalog.generated.ts" ||
  path === "apps/worker/src/engine/blocks/executors.generated.ts";

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

export function plan(paths: readonly string[], repo: Repo = disk): Plan {
  if (paths.length === 0) return { scopes: ["none"], commands: [] };
  const product = any(paths, isProduct);
  const skills = any(paths, isSkill);
  const release = any(paths, isRelease);
  if (paths.every(isDocs) && !product && !skills && !release) {
    return { scopes: ["docs-only"], commands: [C.docsStatus] };
  }

  const worker = any(paths, (path) => path.startsWith("apps/worker/"));
  const dashboard = any(paths, (path) => path.startsWith("apps/dashboard/"));
  const shared = any(paths, (path) => path.startsWith("packages/"));
  const ci = any(paths, isCi);
  const blockCatalog = any(paths, isBlockCatalogSource);
  const gates = any(paths, (path) =>
    path.startsWith("apps/") ||
    path.startsWith("packages/") ||
    path.startsWith("scripts/") ||
    GATE_CONFIG.has(path),
  );
  const rootType = any(paths, (path) => ROOT_TYPE.has(path));
  const workerBaseline = worker || product;
  const workerTests = new Set<string>(product ? WORKFLOW_TESTS : []);
  const dashboardTests = new Set<string>();

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
    dashboard && "dashboard", shared && "shared", product && "product-workflow",
    ci && "ci", release && "release-notes", skills && "skills",
    gates && "gates",
    workerTests.size > 0 && "worker-tests", dashboardTests.size > 0 && "dashboard-tests",
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

  if (rootType || shared) add(C.rootType);
  else {
    if (workerBaseline) add(C.workerType);
    if (dashboard) add(C.dashboardType);
  }
  if (workerBaseline) {
    add(C.preSandbox);
    add(C.skills);
    add(C.mcp);
  } else if (skills) add(C.skills);
  if (release) {
    add(C.releaseType);
    add(C.releaseTest);
  }
  if (ci) add(C.ci);
  if (workerTests.size) {
    const args = [...workerTests].map((path) =>
      FIXED_TESTS.has(path) ? path : `./${path}`,
    );
    add(["pnpm", "--dir", "apps/worker", "exec", "vitest", "run", ...args]);
  }
  if (blockCatalog) add(C.blockCatalog);
  if (dashboardTests.size) {
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
      ...[...dashboardTests].map((path) => `./${path}`),
    ]);
  }
  // Nothing else runs a package's own tests: the worker vitest run and the
  // dashboard node runner never reach packages/*.
  if (shared) add(C.packages);
  if (gates) add(C.gates);
  return { scopes: scopes.length ? scopes : ["unclassified"], commands };
}

const fullSha = (output: Buffer, label: string) => {
  const value = output.toString().trim();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} is not a full SHA.`);
  return value;
};
async function ref(git: Git, name: string): Promise<string | null> {
  try {
    return fullSha(
      await git(["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`]),
      name,
    );
  } catch {
    return null;
  }
}
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
    } catch {
      throw new Error(
        `No merge-base for ${reference}; pass the intended local ref with --base <ref>.`,
      );
    }
  }
  const tried = explicit ? `--base ${JSON.stringify(explicit)}` : "the local base refs";
  throw new Error(
    `Could not resolve ${tried}; pass a local ref or SHA with --base <ref>. This command never fetches.`,
  );
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
          ? fail(new Error(`${program} failed: ${stderr.toString().trim()}`, { cause: error }))
          : ok(stdout),
    ),
  );
}
function execute([program, ...args]: Cmd): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(program, args, { stdio: "inherit", shell: false });
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      code === 0 ? ok() : fail(new Error(`${program} failed: ${signal ?? code}`)),
    );
  });
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
  const resolved = await resolveBase((args) => capture(["git", ...args]), options.base);
  console.log(
    `[verify:changed] base: ${resolved.source} ${resolved.reference} -> ${resolved.baseSha}`,
  );
  console.log(`[verify:changed] candidate: HEAD -> ${resolved.candidateSha}`);
  console.log(`[verify:changed] merge-base: ${resolved.mergeBaseSha}`);
  const checks = candidateDiff(resolved.mergeBaseSha, resolved.candidateSha);
  console.log(`[verify:changed] $ ${show(checks)}`);
  await execute(checks);
  const names = options.worktree
    ? worktreeNamesDiff(resolved.mergeBaseSha, resolved.candidateSha)
    : [namesDiff(resolved.mergeBaseSha, resolved.candidateSha)];
  for (const command of names) console.log(`[verify:changed] $ ${show(command)}`);
  const paths = [
    ...new Set(
      (await Promise.all(names.map((command) => capture(command)))).flatMap((output) => parseNames(output)),
    ),
  ];
  const next = plan(paths);
  console.log(`[verify:changed] changed files: ${JSON.stringify(paths)}`);
  console.log(`[verify:changed] scopes: ${next.scopes.join(", ")}`);
  console.log(
    next.commands.length
      ? `[verify:changed] commands:\n${next.commands.map((cmd) => `  $ ${show(cmd)}`).join("\n")}`
      : "[verify:changed] commands: none (diff checks only)",
  );
  for (const cmd of next.commands) await execute(cmd);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[verify:changed] FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
