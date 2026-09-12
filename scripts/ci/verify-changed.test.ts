import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import {
  candidateDiff,
  listDirectory,
  namesDiff,
  parseArgs,
  parseOptions,
  parseNames,
  plan,
  resolveBase,
  show,
  stagedNamesDiff,
  STAGED_WORKTREE_DIFF,
  WORKFLOW_GRAPH_TESTS,
  WORKFLOW_TESTS,
  WORKTREE_DIFF,
  worktreeNamesDiff,
  type Git,
  type Repo,
} from "./verify-changed.js";

const H = "1".repeat(40);
const U = "2".repeat(40);
const R = "3".repeat(40);
const M = "4".repeat(40);
const B = "5".repeat(40);

function fakeGit(refs: Record<string, string>, failMerge = false) {
  const calls: string[][] = [];
  const run: Git = async (args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse") {
      const ref = args[3].replace(/\^\{commit\}$/, "");
      const value = refs[ref];
      if (value) return Buffer.from(value);
      throw new Error("missing");
    }
    if (args[0] === "merge-base") {
      if (failMerge) throw new Error("unrelated histories");
      return Buffer.from(B);
    }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  return { run, calls };
}

const WB = [
  "pnpm --filter worker run typecheck",
  "pnpm --dir apps/worker run validate:pre-sandbox",
  "pnpm --dir apps/worker run validate:local-skills",
  "pnpm --dir apps/worker run mcp:contract:check",
];
const PACK =
  "pnpm --dir apps/worker exec vitest run " + WORKFLOW_TESTS.join(" ");
const GRAPH_PACK =
  "pnpm --dir apps/worker exec vitest run " +
  [...WORKFLOW_TESTS, ...WORKFLOW_GRAPH_TESTS].join(" ");
const PACKAGES = "pnpm run test:packages";
const GATES = "pnpm run gates";
const commands = (paths: string[], repo?: Repo) =>
  plan(paths, repo).commands.map(show);

test("base precedence is explicit, upstream, origin/HEAD, then origin/main", async () => {
  const cases = [
    { explicit: "chosen", refs: { HEAD: H, chosen: M }, source: "explicit", tried: ["HEAD", "chosen"] },
    { refs: { HEAD: H, "@{upstream}": U }, source: "upstream", tried: ["HEAD", "@{upstream}"] },
    { refs: { HEAD: H, "origin/HEAD": R }, source: "origin/HEAD", tried: ["HEAD", "@{upstream}", "origin/HEAD"] },
    { refs: { HEAD: H, "origin/main": M }, source: "origin/main", tried: ["HEAD", "@{upstream}", "origin/HEAD", "origin/main"] },
  ] as const;
  for (const item of cases) {
    const git = fakeGit(item.refs);
    const result = await resolveBase(git.run, item.explicit);
    assert.equal(result.source, item.source);
    assert.equal(result.candidateSha, H);
    assert.deepEqual(
      git.calls.filter((call) => call[0] === "rev-parse").map((call) => call[3].replace(/\^\{commit\}$/, "")),
      item.tried,
    );
    assert.equal(git.calls.every((call) => call[0] !== "rev-parse" || call[2] === "--end-of-options"), true);
  }
});

test("missing bases fail locally with actionable guidance", async () => {
  await assert.rejects(resolveBase(fakeGit({ HEAD: H }).run), /--base <ref>.*never fetches/);
  await assert.rejects(resolveBase(fakeGit({ HEAD: H }).run, "missing"), /--base "missing".*--base <ref>/);
  await assert.rejects(
    resolveBase(fakeGit({ HEAD: H, chosen: M }, true).run, "chosen"),
    /No merge-base.*--base <ref>/,
  );
});

test("directory discovery ignores deleted paths but fails closed on I/O errors", () => {
  const failure = (code: string) => {
    throw Object.assign(new Error(code), { code });
  };
  assert.deepEqual(listDirectory("missing", () => failure("ENOENT")), []);
  assert.deepEqual(listDirectory("not-directory", () => failure("ENOTDIR")), []);
  assert.throws(() => listDirectory("blocked", () => failure("EACCES")), /EACCES/);
  assert.throws(() => listDirectory("broken", () => failure("EIO")), /EIO/);
});

test("diff commands freeze the candidate SHA and names stay NUL-safe", () => {
  assert.equal(show(WORKTREE_DIFF), "git diff --check");
  assert.deepEqual(candidateDiff(B, H), ["git", "diff", "--check", B, H, "--"]);
  assert.deepEqual(namesDiff(B, H), [
    "git", "diff", "--name-only", "-z", "--no-renames", B, H, "--",
  ]);
  assert.deepEqual(parseNames(Buffer.from("old\0new\0")), ["old", "new"]);
});

test("worktree mode checks staged changes and unions all worktree name sources", () => {
  assert.equal(show(STAGED_WORKTREE_DIFF), "git diff --cached --check");
  assert.deepEqual(stagedNamesDiff(), [
    "git", "diff", "--cached", "--name-only", "-z", "--no-renames", "--",
  ]);
  assert.deepEqual(worktreeNamesDiff(B, H), [
    ["git", "diff", "--name-only", "-z", "--no-renames", B, H, "--"],
    ["git", "diff", "--cached", "--name-only", "-z", "--no-renames", "--"],
    ["git", "diff", "--name-only", "-z", "--no-renames", "--"],
    ["git", "ls-files", "--others", "--exclude-standard", "-z", "--"],
  ]);
});

test("scope table selects only exact narrow commands", () => {
  const rows: Array<[string[], string[]]> = [
    [["README.md", "docs/guide.md"], ["pnpm run gate:docs-status"]],
    [["apps/worker/src/lib/value.ts"], [...WB, GATES]],
    [["apps/worker/src/engine/helpers/value.ts"], [...WB, PACK, GATES]],
    [["apps/dashboard/lib/value.ts"], ["pnpm --filter ai-workflow-dashboard run typecheck", GATES]],
    [["packages/conditions/index.ts"], ["pnpm run typecheck", PACKAGES, GATES]],
    [["packages/costs/index.ts"], ["pnpm run typecheck", PACKAGES, GATES]],
    [["packages/contracts/workflow-graph.ts"], ["pnpm run typecheck", ...WB.slice(1), PACK, PACKAGES, GATES]],
    [["packages/workflow-graph/v2-branch.ts"], ["pnpm run typecheck", ...WB.slice(1), GRAPH_PACK, PACKAGES, GATES]],
    [["apps/worker/vitest.config.ts"], [...WB, PACK, GATES]],
    [["apps/worker/nitro.config.ts"], [...WB, GATES]],
    [["apps/worker/vitest.run-control-workflow.config.ts", "apps/worker/vitest.workflow-divergence.config.ts", "apps/worker/e2e/vitest.e2e.config.ts"], [...WB, GATES]],
    [[".github/workflows/ci.yml"], ["pnpm run test:ci"]],
    [["package.json"], ["pnpm run typecheck", "pnpm run test:ci", GATES]],
    [["pnpm-lock.yaml"], ["pnpm run typecheck", "pnpm run test:ci", GATES]],
    [["scripts/release-notes/render.ts"], ["pnpm run typecheck:release-notes", "pnpm run test:release-notes", GATES]],
    [["docs/releases/artur/next.md"], ["pnpm run typecheck:release-notes", "pnpm run test:release-notes"]],
    [[".github/workflows/prepare-artur-release.yml"], ["pnpm run typecheck:release-notes", "pnpm run test:release-notes", "pnpm run test:ci"]],
    [["skills/ai-workflow-review/SKILL.md"], ["pnpm --dir apps/worker run validate:local-skills"]],
    [[".claude/skills/init-env/SKILL.md"], ["pnpm run gate:docs-status"]],
    [[".claude/settings.json"], ["pnpm run gate:docs-status"]],
    [[".claude/rules/worker-database.md"], ["pnpm run gate:docs-status"]],
    [["apps/worker/.agents/skills/workflow/SKILL.md"], ["pnpm run gate:docs-status"]],
    [[".dependency-cruiser.cjs"], [GATES]],
  ];
  for (const [paths, expected] of rows) assert.deepEqual(commands(paths), expected, paths.join(","));
});

test("a workflow graph package change plans the worker guards and the suites that import the package", () => {
  const planned = commands(["packages/workflow-graph/v2-bindings.ts"]).find(
    (command) => command.includes("vitest run"),
  );
  for (const suite of [
    "src/engine/workflow-import-boundary.test.ts",
    "src/engine/step-registration-coverage.test.ts",
    "src/routes/import-graph-guard.test.ts",
    "src/workflow-definition/v2-bindings.test.ts",
    "src/workflow-definition/v2-branch.test.ts",
  ]) {
    assert.equal(planned?.includes(` ${suite}`), true, suite);
  }
});

test("directory discovery includes test variants, direct tests, safety prefixes, and excludes deleted tests", () => {
  const files = new Set([
    "apps/worker/src/lib/tool.behavior.test.ts",
    "apps/worker/src/lib/tool.integration.spec.tsx",
    "apps/worker/src/lib/tool.test.ts",
    "apps/worker/src/lib/direct.test.ts",
    "apps/dashboard/-danger.test.ts",
  ]);
  const repo: Repo = {
    exists: (path) => files.has(path),
    list: (dir) =>
      dir === "apps/worker/src/lib"
        ? ["tool.test.ts", "tool.integration.spec.tsx", "tool.behavior.test.ts", "tool.test.js"]
        : [],
  };
  const worker = commands(
    ["apps/worker/src/lib/tool.ts", "apps/worker/src/lib/direct.test.ts", "apps/worker/src/lib/deleted.test.ts"],
    repo,
  );
  const workerVitest = worker.find((command) => command.includes("vitest run"));
  assert.equal(
    worker.at(-1),
    GATES,
  );
  assert.equal(
    workerVitest,
    "pnpm --dir apps/worker exec vitest run ./src/lib/tool.behavior.test.ts ./src/lib/tool.integration.spec.tsx ./src/lib/tool.test.ts ./src/lib/direct.test.ts",
  );
  assert.equal(workerVitest?.includes("deleted"), false);
  assert.equal(
    commands(["apps/dashboard/-danger.test.ts"], repo).at(-2),
    "pnpm --dir apps/dashboard exec node --experimental-test-module-mocks --import tsx --test ./-danger.test.ts",
  );
});

test("fixed tests and overlapping changed tests deduplicate into one process", () => {
  const path = "apps/worker/src/workflow-definition/block-registry.test.ts";
  const repo: Repo = { exists: (candidate) => candidate === path, list: () => [] };
  const result = commands([path, path], repo);
  assert.equal(result.filter((value) => value.includes("vitest run")).length, 1);
  assert.equal(result.at(-2), PACK);
  assert.equal(new Set(result).size, result.length);
});

test("combined plan excludes broad, deployment, network, E2E, and divergence commands", () => {
  const result = plan([
    "package.json", "packages/contracts/workflow-graph.ts", "apps/dashboard/lib/x.ts",
    "scripts/release-notes/x.ts", ".github/workflows/ci.yml", "skills/x/SKILL.md",
  ]).commands;
  for (const [program, ...args] of result) {
    assert.equal(["gh", "curl", "jira"].includes(program), false);
    for (const forbidden of ["build", "test:e2e", "test:workflow-sdk", "test:workflow-sdk-divergence", "fetch"])
      assert.equal(args.includes(forbidden), false);
    assert.notDeepEqual(args, ["run", "test"]);
  }
});

test("CLI, package entry, and executable hook preserve the exact public contract", async () => {
  assert.equal(parseArgs(["--", "--base", "origin/main"]), "origin/main");
  assert.equal(parseArgs(["--base=main"]), "main");
  assert.deepEqual(parseOptions(["--base", "origin/main", "--worktree"]), {
    base: "origin/main",
    worktree: true,
  });
  assert.throws(() => parseArgs(["--fetch"]), /Unknown/);
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["verify:changed"], "node --import tsx scripts/ci/verify-changed.ts");
  const hook = ".githooks/pre-push";
  assert.equal(
    await readFile(hook, "utf8"),
    "#!/bin/sh\nset -eu\n\n# Git exports GIT_DIR into hook processes when HEAD lives in a linked\n# worktree. Tests that spawn git inside temporary directories would then\n# operate on this repository instead of their fixture, so drop the discovery\n# variables before the gate starts; verify:changed resolves the repository\n# from its working directory.\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\n\nexec pnpm run verify:changed\n",
  );
  assert.notEqual((await stat(hook)).mode & 0o111, 0);
  execFileSync("sh", ["-n", hook], { stdio: "pipe" });
});
