import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import {
  candidateDiff,
  assertCandidate,
  CONNECTION_SHAPE_TEST,
  INTEGRATION_SDK_SEAM_TESTS,
  listDirectory,
  namesDiff,
  parseArgs,
  parseOptions,
  parseNames,
  plan,
  resolveBase,
  runPlanned,
  show,
  stagedNamesDiff,
  STAGED_WORKTREE_DIFF,
  WORKFLOW_GRAPH_TESTS,
  WORKFLOW_TESTS,
  WORKTREE_DIFF,
  worktreeNamesDiff,
  type Cmd,
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
      throw Object.assign(new Error(`unknown revision ${ref}`), { code: 128 });
    }
    if (args[0] === "merge-base") {
      if (failMerge) throw Object.assign(new Error("unrelated histories"), { code: 1 });
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
  "pnpm --dir apps/worker run test:zod4",
];
const PACK =
  "pnpm --dir apps/worker exec vitest run " + WORKFLOW_TESTS.join(" ");
const GRAPH_PACK =
  "pnpm --dir apps/worker exec vitest run " +
  [...WORKFLOW_TESTS, ...WORKFLOW_GRAPH_TESTS].join(" ");
const PACKAGES = ["pnpm run test:packages", "pnpm run test:packages:zod4"];
const REGISTRY = "pnpm run gen:integrations --check";
const GRAPH_ZOD4 = "pnpm --filter @shared/workflow-graph run test:zod4";
const SDK_SEAM =
  "pnpm --dir apps/worker exec vitest run " + INTEGRATION_SDK_SEAM_TESTS.join(" ");
const SDK_SEAM_WITH_SHAPE =
  "pnpm --dir apps/worker exec vitest run " +
  [...INTEGRATION_SDK_SEAM_TESTS, ...CONNECTION_SHAPE_TEST].join(" ");
const SDK = "pnpm run test:workflow-sdk";
const GATES = "pnpm run gates";
const BLOCK_CATALOG = "pnpm run gen:blocks --check";
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
    const result = await resolveBase(
      git.run,
      "explicit" in item ? item.explicit : undefined,
    );
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

test("reference lookup propagates repository failures instead of treating them as missing refs", async () => {
  const git: Git = async (args) => {
    if (args[0] === "rev-parse") {
      throw Object.assign(new Error("fatal: not a git repository"), { code: 128 });
    }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(resolveBase(git), /not a git repository/);
});

test("a candidate that moves during verification is refused with both SHAs", async () => {
  const git: Git = async (args) => {
    if (args[0] === "rev-parse") return Buffer.from(U);
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    assertCandidate(git, H, "before planned checks"),
    new RegExp(`Candidate moved during before planned checks: expected ${H}, found ${U}`),
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

test("an empty changed path set is an explicit no-op, while an unknown path is a scope failure", () => {
  assert.deepEqual(plan([]), {
    status: "NOOP",
    scopes: ["none"],
    commands: [],
    errors: [],
  });

  const invalid = plan(["docs/guide.md", "tmp/agent-output.json"]);
  assert.equal(invalid.status, "INVALID_SCOPE");
  assert.deepEqual(invalid.scopes, ["unclassified"]);
  assert.deepEqual(invalid.errors, [
    "No verification scope is defined for changed path(s): tmp/agent-output.json.",
  ]);
  assert.deepEqual(invalid.commands, [["pnpm", "run", "gate:docs-status"]]);
});

test("documentation remains an obligation when a product change shares the plan", () => {
  const planned = commands(["docs/guide.md", "apps/worker/src/lib/value.ts"]);
  assert.equal(planned.includes("pnpm run gate:docs-status"), true);
});

test("scope table selects only exact narrow commands", () => {
  const rows: Array<[string[], string[]]> = [
    [["README.md", "docs/guide.md"], ["pnpm run gate:docs-status"]],
    [["apps/worker/src/lib/value.ts"], [...WB, GATES]],
    [["apps/worker/src/engine/helpers/value.ts"], [...WB, PACK, SDK, GATES]],
    [["apps/worker/src/engine/agent-workflow.ts"], [...WB, PACK, SDK, GATES]],
    [["apps/worker/workflow-test-fixtures/run-control/workflow.ts"], [...WB, PACK, SDK, GATES]],
    [["apps/worker/workflow-sdk-tests/run-control-workflow-sdk.test.ts"], [...WB, SDK, GATES]],
    [["apps/worker/workflow-sdk-tests/divergence/wdk-wait-divergence.test.ts"], [...WB, GATES]],
    [["apps/dashboard/lib/value.ts"], ["pnpm --filter ai-workflow-dashboard run typecheck", GATES]],
    [["packages/conditions/index.ts"], ["pnpm run typecheck", ...PACKAGES, GATES]],
    [["packages/costs/index.ts"], ["pnpm run typecheck", ...PACKAGES, GATES]],
    [["integrations/sdk/index.ts"], ["pnpm run typecheck", SDK_SEAM, REGISTRY, ...PACKAGES, GATES]],
    [["integrations/sdk/conformance.test.ts"], ["pnpm run typecheck", SDK_SEAM, REGISTRY, ...PACKAGES, GATES]],
    [["integrations/_fixtures/demo/manifest.ts"], ["pnpm run typecheck", SDK_SEAM_WITH_SHAPE, REGISTRY, ...PACKAGES, GATES]],
    [["scripts/gates/generate-integration-registry/render.ts"], ["pnpm run test:ci", REGISTRY, GATES]],
    [["packages/contracts/workflow-graph.ts"], ["pnpm run typecheck", ...WB.slice(1), PACK, ...PACKAGES, GATES]],
    [["packages/workflow-graph/v2-branch.ts"], ["pnpm run typecheck", ...WB.slice(1), GRAPH_PACK, SDK, ...PACKAGES, GRAPH_ZOD4, GATES]],
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
    [[".claude/hooks/context-budget-guard.mjs"], ["pnpm run test:ci"]],
    [[".claude/context-budget.tsv"], ["pnpm run test:ci"]],
    [[".codex/hooks.json"], ["pnpm run test:ci"]],
    [[".codex/hooks/context-budget-guard.mjs"], ["pnpm run test:ci"]],
    [["apps/worker/.agents/skills/workflow/SKILL.md"], ["pnpm run gate:docs-status"]],
    [[".dependency-cruiser.cjs"], [GATES]],
    [["scripts/gates/boundaries.mjs"], ["pnpm run test:ci", GATES]],
    [["scripts/changelog/publish.ts"], ["pnpm run test:ci", GATES]],
  ];
  for (const [paths, expected] of rows) assert.deepEqual(commands(paths), expected, paths.join(","));
});

test("an integration package change is a known scope that runs the SDK's own suites and its seam in the worker", () => {
  const planned = plan(["integrations/sdk/capabilities.ts"]);
  assert.equal(planned.status, "READY");
  assert.deepEqual(planned.errors, []);
  assert.equal(planned.scopes.includes("integrations"), true);
  const shown = new Set(planned.commands.map(show));
  for (const command of ["pnpm run typecheck", ...PACKAGES, SDK_SEAM, REGISTRY]) {
    assert.equal(shown.has(command), true, command);
  }
  assert.deepEqual(commands(["integrations/sdk/NOTES.md"]), ["pnpm run gate:docs-status"]);
});

test("editing an integration's manifest pins the connection shape; editing only its worker or README does not", () => {
  const manifestPlanned = commands(["integrations/jira/manifest.ts"]);
  assert.equal(
    manifestPlanned.some((command) => command.includes("connection-shape.test.ts")),
    true,
    manifestPlanned.join(", "),
  );

  const workerOnlyPlanned = commands(["integrations/jira/worker.ts"]);
  assert.equal(
    workerOnlyPlanned.some((command) => command.includes("connection-shape.test.ts")),
    false,
    workerOnlyPlanned.join(", "),
  );

  const readmeOnlyPlanned = commands(["integrations/jira/README.md"]);
  assert.equal(
    readmeOnlyPlanned.some((command) => command.includes("connection-shape.test.ts")),
    false,
    readmeOnlyPlanned.join(", "),
  );
});

// Red when: a file that composes a prompt changes and the plan runs only that
// file's own tests, so a committed golden prompt goes stale on this machine
// and only CI notices (PR #538: sandbox/context.ts moved, golden.test.ts was
// never planned).
test("editing a prompt source plans the prompt golden and oracle tests", () => {
  for (const path of [
    "apps/worker/src/sandbox/context.ts",
    "packages/prompts/prompt-parts.ts",
    "apps/worker/src/engine/helpers/effective-prompt.ts",
    "apps/worker/src/engine/repository-discovery/runner.ts",
    "apps/worker/src/engine/blocks/generic-agent/execute.ts",
    "apps/worker/src/test-support/prompt-oracle/__golden__/implementation.parts.txt",
  ]) {
    const planned = commands([path]);
    for (const oracle of ["prompt-oracle/golden.test.ts", "prompt-oracle/oracle.test.ts"]) {
      assert.equal(
        planned.some((command) => command.includes(oracle)),
        true,
        `${path} -> ${planned.join(", ")}`,
      );
    }
  }

  const unrelated = commands(["apps/worker/src/sandbox/attachments.ts"]);
  assert.equal(
    unrelated.some((command) => command.includes("prompt-oracle/")),
    false,
    unrelated.join(", "),
  );
});

test("a workflow graph package change plans the worker guards and the suites that import the package", () => {
  const planned = commands(["packages/workflow-graph/v2-bindings.ts"]).find(
    (command) => command.includes("vitest run"),
  );
  for (const suite of [
    "src/engine/workflow-import-boundary.test.ts",
    "src/engine/step-registration-coverage.test.ts",
    "src/routes/import-graph-guard.test.ts",
    "src/workflow-graph-suites/v2-bindings.test.ts",
    "src/workflow-graph-suites/v2-branch.test.ts",
  ]) {
    assert.equal(planned?.includes(` ${suite}`), true, suite);
  }
});

test("the workflow-sdk suite is planned by every path that decides its bundles", () => {
  const planned = [
    "packages/workflow-graph/v2-bindings.ts",
    "apps/worker/src/engine/agent-workflow.ts",
    "apps/worker/src/engine/helpers/prompt-output.ts",
    "apps/worker/src/engine/helpers/effective-prompt.ts",
    "apps/worker/workflow-test-fixtures/v2-concurrent/workflow.ts",
    "apps/worker/workflow-sdk-tests/v2-concurrent.test.ts",
  ];
  for (const path of planned) {
    assert.equal(commands([path]).includes(SDK), true, path);
  }
  const skipped = [
    "apps/worker/src/engine/blocks/call-llm.ts",
    "apps/worker/workflow-sdk-tests/divergence/wdk-sleep-repro.test.ts",
    "packages/contracts/workflow-graph.ts",
  ];
  for (const path of skipped) {
    assert.equal(commands([path]).includes(SDK), false, path);
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

const DASHBOARD = "apps/dashboard";

async function dashboardTestFiles(directory = DASHBOARD): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // A dot directory and the dependency tree hold no suite of ours, and
    // pnpm links the second one, so descending it would leave the package.
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await dashboardTestFiles(path)));
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path.slice(DASHBOARD.length + 1));
  }
  return found.sort();
}

/**
 * The dashboard runs on `node --test`, which reads its positionals as globs:
 * a path is not a path. `app/api/users/[userId]/role/route.test.ts` arrived as
 * a character class, matched nothing, and the run reported zero tests and
 * exited green, so that file never ran and nobody could tell.
 *
 * Counting what the planned commands reach against what is on disk is what
 * makes the next path shape nobody predicted fail instead of disappear.
 */
test("the plan reaches every dashboard test file that is on disk", async () => {
  const onDisk = await dashboardTestFiles();
  assert.ok(onDisk.length >= 100, `walked ${onDisk.length} test files, expected the suite`);

  const reached = new Set<string>();
  for (const relative of onDisk) {
    const command = plan([`${DASHBOARD}/${relative}`]).commands.find((cmd) =>
      cmd.includes("--test"),
    );
    assert.ok(command, `no dashboard run planned for ${relative}`);
    for (const pattern of command.slice(command.indexOf("--test") + 1)) {
      for await (const file of glob(pattern, { cwd: DASHBOARD })) reached.add(file);
    }
  }
  assert.deepEqual([...reached].sort(), onDisk);
});

test("fixed tests and overlapping changed tests deduplicate into one process", () => {
  const path = "apps/worker/src/engine/definition/block-registry.test.ts";
  const repo: Repo = { exists: (candidate) => candidate === path, list: () => [] };
  const result = commands([path, path], repo);
  assert.equal(result.filter((value) => value.includes("vitest run")).length, 1);
  // The registry now sits under engine/definition/, which is also a block
  // catalog source, so the tail gained `gen:blocks --check` between the suite
  // and the gates. The order is still pinned, one position further back.
  assert.equal(result.at(-1), GATES);
  assert.equal(result.at(-2), BLOCK_CATALOG);
  assert.equal(result.at(-3), PACK);
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

/**
 * `--if-present` handed a package with no suite the meaning "passed", which is
 * how `test:packages:zod4` came to claim seven packages while running two. The
 * root scripts now name the packages they run, and this test is the index that
 * keeps the named list equal to the packages that actually own the script, so a
 * new package cannot silently opt out of the run either.
 */
test("the package test scripts name every package that owns the script they run", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  // Integration packages are workspace packages too: a package there that owns
  // a test script and is missing from the root list would never run in CI.
  const roots = ["packages", "integrations"];
  const manifests = (
    await Promise.all(
      roots.map(async (root) =>
        Promise.all(
          (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && existsSync(`${root}/${entry.name}/package.json`))
            .map(async (entry) => {
              const file = `${root}/${entry.name}/package.json`;
              return JSON.parse(await readFile(file, "utf8")) as {
                name: string;
                scripts?: Record<string, string>;
              };
            }),
        ),
      ),
    )
  ).flat();
  assert.ok(manifests.length >= 7, "every workspace package carries a package.json");

  const owners = (script: string) =>
    manifests.filter((pkg) => pkg.scripts?.[script]).map((pkg) => pkg.name).sort();
  const named = (command: string) =>
    [...command.matchAll(/--filter (\S+)/g)].map((match) => match[1]).sort();

  assert.deepEqual(named(root.scripts["test:packages"]), owners("test"));
  assert.deepEqual(named(root.scripts["test:packages:zod4"]), owners("test:zod4"));
  assert.match(root.scripts["test:packages"], / run test$/);
  assert.match(root.scripts["test:packages:zod4"], / run test:zod4$/);
  for (const key of ["test:packages", "test:packages:zod4"]) {
    assert.equal(
      root.scripts[key].includes("--if-present"),
      false,
      `${key} must not count a missing script as a pass`,
    );
  }
});

/**
 * A package listed above can still run less than it holds. `node --test` runs
 * what its globs match and reports "tests 0" with exit 0 when they match
 * nothing, so a test beside page code in `dashboard/`, in a `test/` folder or
 * named `.test.tsx` under a `"*.test.ts"` script never runs, and a test broken
 * on purpose stays green. vitest finds nested files on its own, so only the
 * node runner's globs are read here, the same way the runner reads them.
 */
test("every test file in a package is one its own test script runs", async () => {
  const directories = (
    await Promise.all(
      ["packages", "integrations"].map(async (root) =>
        (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && existsSync(`${root}/${entry.name}/package.json`))
          .map((entry) => `${root}/${entry.name}`),
      ),
    )
  ).flat();
  let checked = 0;
  for (const directory of directories) {
    const script = (JSON.parse(await readFile(`${directory}/package.json`, "utf8")) as {
      scripts?: Record<string, string>;
    }).scripts?.test;
    if (!script || !/\s--test\s/u.test(script)) continue;
    checked += 1;
    const patterns = [...script.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
    const run = new Set<string>();
    for await (const file of glob(patterns, { cwd: directory })) run.add(file);
    const held: string[] = [];
    for await (const file of glob("**/*.test.{ts,tsx,mts,js,mjs}", {
      cwd: directory,
      exclude: (name) => name === "node_modules",
    })) {
      held.push(file);
    }
    assert.ok(held.length > 0, `${directory} has a test script and no test file, so its run proves nothing`);
    assert.deepEqual(
      held.filter((file) => !run.has(file)).sort(),
      [],
      `${directory}'s test script (${script}) does not run these files. Use "!(node_modules)/**/*.test.{ts,tsx}" "*.test.{ts,tsx}", as integrations/_template does.`,
    );
  }
  assert.ok(checked >= 5, "no package runs node --test, so this proves nothing");
});

const TYPECHECK: Cmd = ["pnpm", "run", "typecheck"];
const TEST_CI: Cmd = ["pnpm", "run", "test:ci"];
const RUN_GATES: Cmd = ["pnpm", "run", "gates"];

test("every planned command is echoed with its position before it starts", async () => {
  const lines: string[] = [];
  const started: string[] = [];
  await runPlanned(
    [TYPECHECK, TEST_CI, RUN_GATES],
    async (cmd) => {
      // The echo has to precede the command, or a killed run loses the one
      // line that says which command it died inside.
      assert.deepEqual(lines.at(-1)?.endsWith(show(cmd)), true, show(cmd));
      started.push(show(cmd));
    },
    (line) => lines.push(line),
  );
  assert.deepEqual(started, ["pnpm run typecheck", "pnpm run test:ci", "pnpm run gates"]);
  assert.deepEqual(lines, [
    "[verify:changed] 1/3 $ pnpm run typecheck",
    "[verify:changed] 2/3 $ pnpm run test:ci",
    "[verify:changed] 3/3 $ pnpm run gates",
  ]);
  assert.equal(lines.join("\n").includes("NOT RUN"), false);
});

test("a failure names the command that failed and refuses to pass off what never ran", async () => {
  const lines: string[] = [];
  const started: string[] = [];
  await assert.rejects(
    runPlanned(
      [TYPECHECK, TEST_CI, RUN_GATES],
      async (cmd) => {
        started.push(show(cmd));
        if (show(cmd) === "pnpm run test:ci") throw new Error("pnpm failed: 1");
      },
      (line) => lines.push(line),
    ),
    /^Error: 2\/3 pnpm run test:ci failed: pnpm failed: 1$/,
  );
  // The loop stops at the first failure, so the gates never started.
  assert.deepEqual(started, ["pnpm run typecheck", "pnpm run test:ci"]);
  assert.deepEqual(lines, [
    "[verify:changed] 1/3 $ pnpm run typecheck",
    "[verify:changed] 2/3 $ pnpm run test:ci",
    "[verify:changed] FAILED 2/3: pnpm run test:ci",
    "[verify:changed] NOT RUN: 1 command after the failure never started. They are unproven, not passed.\n  3/3 $ pnpm run gates",
  ]);
});

test("the unproven list carries every later command and says so when there is none", async () => {
  const many: Cmd[] = [TYPECHECK, TEST_CI, RUN_GATES, ["pnpm", "run", "gate:docs-status"]];
  const lines: string[] = [];
  await assert.rejects(
    runPlanned(
      many,
      async (cmd) => {
        if (show(cmd) === "pnpm run typecheck") throw new Error("pnpm failed: 2");
      },
      (line) => lines.push(line),
    ),
    /1\/4 pnpm run typecheck failed/,
  );
  assert.equal(
    lines.at(-1),
    "[verify:changed] NOT RUN: 3 commands after the failure never started. They are unproven, not passed." +
      "\n  2/4 $ pnpm run test:ci\n  3/4 $ pnpm run gates\n  4/4 $ pnpm run gate:docs-status",
  );

  const tail: string[] = [];
  await assert.rejects(
    runPlanned(
      [TYPECHECK],
      async () => {
        throw new Error("pnpm failed: 1");
      },
      (line) => tail.push(line),
    ),
    /1\/1 pnpm run typecheck failed/,
  );
  assert.equal(
    tail.at(-1),
    "[verify:changed] NOT RUN: none, the failure was the last command in the plan.",
  );
});
