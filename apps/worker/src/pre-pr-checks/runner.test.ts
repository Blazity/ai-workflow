import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_MANIFEST_PATH } from "../sandbox/repo-workspace.js";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();

let sandboxStatus = "running";

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      get status() {
        return sandboxStatus;
      },
      runCommand: mockRunCommand,
      writeFiles: mockWriteFiles,
    })),
  },
}));

vi.mock("../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  boundFailureOutput,
  buildBatchReaderScript,
  buildRepoCheckBatchScript,
  collectPrePrRepairStep,
  collectRepoCheckBatchStep,
  listWorkspaceRepositoriesStep,
  parseBatchReaderOutput,
  repoCheckBatchPaths,
  startPrePrRepairStep,
  startRepoCheckBatchStep,
  type RepoCheckBatchPaths,
} from "./runner.js";

const manifest = {
  version: 1,
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      slug: "github__acme__web",
      localPath: "/vercel/sandbox",
      defaultBranch: "main",
      branchName: "blazebot/aiw-52",
      selectedRationale: "ticket mentions web",
      preAgentSha: "web-base",
    },
    {
      provider: "gitlab",
      repoPath: "acme/api",
      slug: "gitlab__acme__api",
      localPath: "/vercel/sandbox/repos/gitlab__acme__api",
      defaultBranch: "main",
      branchName: "blazebot/aiw-52",
      selectedRationale: "ticket mentions api",
      preAgentSha: "api-base",
    },
  ],
};

describe("buildRepoCheckBatchScript", () => {
  const paths = repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd");

  it("runs every setup and check command through its own login shell", () => {
    // The semantic this pins: Arthur's real setup appends a PATH export to the
    // shell profile and every later command depends on picking it up. That only
    // works while each command starts a fresh login shell of its own, so a
    // refactor that concatenates the batch into one shell body, or that makes
    // the wrapper itself the single login shell, must fail here.
    const script = buildRepoCheckBatchScript({
      paths,
      localPath: "/vercel/sandbox",
      setup: ["curl -LsSf https://astral.sh/uv/install.sh | sh", "uv sync"],
      commands: ["uv run mypy ."],
    });

    expect(script).toContain('bash -lc "$2"');
    expect(script.match(/^run_pre_pr_command /gm)).toHaveLength(3);
    expect(script).toContain(
      "run_pre_pr_command 0 'curl -LsSf https://astral.sh/uv/install.sh | sh'",
    );
    expect(script).toContain("run_pre_pr_command 1 'uv sync'");
    expect(script).toContain("run_pre_pr_command 2 'uv run mypy .'");
    // One `bash -lc` dispatcher, never one per authored command inlined.
    expect(script.match(/bash -lc/g)).toHaveLength(1);
  });

  it("stops the batch at a failing setup command and never at a check", () => {
    const script = buildRepoCheckBatchScript({
      paths,
      localPath: "/vercel/sandbox",
      setup: ["make bootstrap", "make deps"],
      commands: ["pnpm lint", "pnpm test"],
    });

    expect(script).toContain(
      "run_pre_pr_command 0 'make bootstrap'\n[ \"$PRE_PR_EXIT\" -eq 0 ] || stop_batch 0",
    );
    expect(script).toContain(
      "run_pre_pr_command 1 'make deps'\n[ \"$PRE_PR_EXIT\" -eq 0 ] || stop_batch 1",
    );
    // Checks keep running after one of them fails, exactly as the blocking
    // runner did: only setup short-circuits.
    expect(script).not.toContain("stop_batch 2");
    expect(script).not.toContain("stop_batch 3");
  });

  it("clears the prior cycle's files first and touches the sentinel last", () => {
    const script = buildRepoCheckBatchScript({
      paths,
      localPath: "/vercel/sandbox",
      setup: [],
      commands: ["pnpm lint"],
    });

    const lines = script.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(`touch ${paths.sentinel}`);
    expect(script.indexOf(`rm -f ${paths.sentinel}`)).toBeLessThan(
      script.indexOf("run_pre_pr_command 0"),
    );
    expect(script.indexOf(`rm -rf ${paths.dir}`)).toBeLessThan(
      script.indexOf("run_pre_pr_command 0"),
    );
  });

  it("writes its own identity before it can write any output file", () => {
    // The collector refuses a directory whose launch marker is not its own, so
    // the marker has to be written before anything else could appear there.
    const script = buildRepoCheckBatchScript({
      paths,
      localPath: "/vercel/sandbox",
      setup: [],
      commands: ["pnpm lint"],
    });

    expect(script).toContain(`echo '${paths.launchId}' > ${paths.dir}/launch`);
    expect(script.indexOf(`${paths.dir}/launch`)).toBeLessThan(
      script.indexOf("run_pre_pr_command 0"),
    );
  });

  it("installs no signal trap, because a trap here cannot work", () => {
    // Two reasons, both fatal to the idea. Bash runs a trap only once the
    // current foreground command finishes (SIGNALS in bash(1)), so a handler
    // could never fire while a check is running, which is the only moment it
    // would have anything to kill. And `kill 0` signals the whole process
    // group, which includes whatever launched the wrapper. Killing the launched
    // command is stopPhaseCommand's job, through the sandbox API.
    const script = buildRepoCheckBatchScript({
      paths,
      localPath: "/vercel/sandbox",
      setup: [],
      commands: ["pnpm test"],
    });

    expect(script).not.toMatch(/^\s*trap /m);
    expect(script).not.toMatch(/^\s*kill /m);
  });

  it("keeps every fix cycle, repository and launch on its own paths", () => {
    const id = "aaaabbbbccccdddd";
    expect(repoCheckBatchPaths(0, 1, id).dir).not.toBe(repoCheckBatchPaths(1, 1, id).dir);
    expect(repoCheckBatchPaths(1, 0, id).sentinel).not.toBe(
      repoCheckBatchPaths(1, 1, id).sentinel,
    );
    // Two launches of the same cycle and repository are still two directories:
    // a shared one would let the union of two partial batches read as complete.
    expect(repoCheckBatchPaths(1, 1, "1111111111111111").dir).not.toBe(
      repoCheckBatchPaths(1, 1, "2222222222222222").dir,
    );
  });
});


describe("the batch reader shell", () => {
  // The collector suite above runs this same script for every case it covers.
  // This suite reads its records directly, so the wire format itself is pinned
  // rather than inferred from what the collector made of it.
  const files = {
    present: "two lines\nof output",
    empty: "",
    oversized: `HEAD${"x".repeat(20_000)}TAIL`,
    blocked: `${"y".repeat(9_000)}error: run \`yarn install\` first`,
  };

  function read(scanBlockedDependencies = true, profileNoise = "") {
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-reader-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
      }
      const script = buildBatchReaderScript({
        dir,
        names: [...Object.keys(files), "absent"],
        scanBlockedDependencies,
      });
      const stdout = execFileSync("bash", ["-lc", `${profileNoise}${script}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout, parsed: parseBatchReaderOutput(stdout) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("emits one record per file, whatever state the file is in", () => {
    const { parsed } = read();

    expect(parsed.get("present")).toMatchObject({ bytes: 19, blocked: false, tail: null });
    expect(Buffer.from(parsed.get("present")!.head, "base64").toString()).toBe(files.present);
    // Empty and absent are different answers: one command ran and produced
    // nothing, the other never ran at all.
    expect(parsed.get("empty")).toMatchObject({ bytes: 0, head: "", tail: null });
    expect(parsed.get("absent")).toMatchObject({ bytes: -1, head: "", tail: null });
    // Oversized keeps both ends and reports the true size, so the collector can
    // say how much it dropped.
    const oversized = parsed.get("oversized")!;
    expect(oversized.bytes).toBe(files.oversized.length);
    expect(Buffer.from(oversized.head, "base64").toString()).toContain("HEAD");
    expect(Buffer.from(oversized.tail!, "base64").toString()).toContain("TAIL");
  });

  it("finds a blocked-dependency phrase the truncation would have cut away", () => {
    const { parsed } = read();

    expect(parsed.get("blocked")!.blocked).toBe(true);
    // Proof that only the whole-file grep could have found it.
    expect(Buffer.from(parsed.get("blocked")!.head, "base64").toString()).not.toContain(
      "yarn install",
    );
  });

  it("reports nothing blocked when the caller did not ask for the scan", () => {
    const { parsed } = read(false);

    expect(parsed.get("blocked")!.blocked).toBe(false);
  });

  it("skips whatever the shell profile printed instead of absorbing it", () => {
    // The reader runs under `bash -lc`, which sources the profile our setup
    // commands append to. Without a token to match, output with no trailing
    // newline glues itself onto the first record and turns a batch that ran to
    // completion into "the wrapper never started".
    const { stdout, parsed } = read(true, 'printf "nvm: version 20.11.1";');

    expect(stdout.startsWith("nvm: version")).toBe(true);
    // Every record survives: the leading newline ends the profile's line, and
    // the marker means a line that is not a record is skipped rather than read
    // as a file called "nvm:".
    expect(parsed.get("present")).toBeDefined();
    expect(parsed.get("empty")).toBeDefined();
    expect(parsed.get("absent")).toBeDefined();
    expect([...parsed.keys()].sort()).toEqual([
      "absent",
      "blocked",
      "empty",
      "oversized",
      "present",
    ]);
  });
});

describe("startRepoCheckBatchStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("launches a changed repository's batch detached and runs no command inline", async () => {
    mockRunCommand.mockImplementation(sandboxWithHead("web-head"));

    const started = await startRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      ["make deps"],
      ["pnpm typecheck"],
      0,
      0,
    );

    expect(started).toMatchObject({
      skipped: false,
      commandId: "cmd-batch",
      localPath: "/vercel/sandbox",
    });
    expect(started.skipped).toBe(false);
    if (started.skipped) throw new Error("unreachable");
    expect(started.paths.wrapper).toBe(
      `/tmp/pre-pr-checks-c0-r0-${started.paths.launchId}-wrapper.sh`,
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "bash",
        args: [started.paths.wrapper],
        detached: true,
      }),
    );
    // The invocation that launches the batch must not also await it: nothing
    // here may run a configured command through a blocking runCommand.
    expect(mockRunCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ args: ["-lc", "pnpm typecheck"] }),
    );
    const wrapper = mockWriteFiles.mock.calls[0]![0][0].content.toString();
    expect(wrapper).toContain("run_pre_pr_command 0 'make deps'");
    expect(wrapper).toContain("run_pre_pr_command 1 'pnpm typecheck'");
  });

  it("skips a repository whose HEAD never moved", async () => {
    mockRunCommand.mockImplementation(sandboxWithHead("web-base"));

    const started = await startRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      0,
      0,
    );

    expect(started).toEqual({ skipped: true });
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it("skips a configured repository the workspace never attached", async () => {
    mockRunCommand.mockImplementation(sandboxWithHead("web-head"));

    const started = await startRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/absent",
      [],
      ["pnpm typecheck"],
      0,
      0,
    );

    expect(started).toEqual({ skipped: true });
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it("starts an unchanged repository, and inspects no HEAD, when change is not required", async () => {
    // The explicit-commands mode of run_checks runs in every attached
    // repository whether or not its HEAD moved, and never inspected HEAD at
    // all, so it must not start failing on an unreadable git directory.
    mockRunCommand.mockImplementation(sandboxWithHead("web-base"));

    const started = await startRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm lint"],
      0,
      0,
      false,
    );

    expect(started).toMatchObject({ skipped: false, commandId: "cmd-batch" });
    expect(mockRunCommand).not.toHaveBeenCalledWith("git", expect.anything());
  });

  it("treats inability to inspect a repository as an execution failure", async () => {
    mockRunCommand.mockImplementation((cmd: unknown, args: unknown) => {
      if (cmd === "cat" && Array.isArray(args) && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git") return commandResult(128, "", "repository disappeared");
      return commandResult(0, "");
    });

    await expect(
      startRepoCheckBatchStep("sbx-test-123", "github", "acme/web", [], ["pnpm typecheck"], 0, 0),
    ).rejects.toThrow("Could not inspect workspace HEAD for github:acme/web");
  });
});

describe("listWorkspaceRepositoriesStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns every attached repository in manifest order", async () => {
    mockRunCommand.mockImplementation(sandboxWithHead("web-head"));

    await expect(listWorkspaceRepositoriesStep("sbx-test-123")).resolves.toEqual([
      { provider: "github", repoPath: "acme/web" },
      { provider: "gitlab", repoPath: "acme/api" },
    ]);
  });

  it("fails when the workspace manifest is missing", async () => {
    mockRunCommand.mockImplementation(() => commandResult(1, "", "no such file"));

    await expect(listWorkspaceRepositoriesStep("sbx-test-123")).rejects.toThrow(
      "Workspace manifest not found",
    );
  });
});

describe("collectRepoCheckBatchStep", () => {
  const paths = repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd");

  beforeEach(() => {
    vi.clearAllMocks();
    sandboxStatus = "running";
  });

  it("retains every ordered check result and reports the failing one", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "1",
        "stderr-0": "lint failed",
        "exit-1": "0",
        "stdout-1": "tests passed",
      }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm lint", "pnpm test"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.results).toEqual([
      { provider: "github", repoPath: "acme/web", command: "pnpm lint", exitCode: 1 },
      { provider: "github", repoPath: "acme/web", command: "pnpm test", exitCode: 0 },
    ]);
    expect(collected.failures).toHaveLength(1);
    expect(collected.failures[0]).toMatchObject({ command: "pnpm lint", stderr: "lint failed" });
    expect(collected.setupFailed).toBe(false);
  });

  it("stops a repository's checks at a failing setup command", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "stopped-at": "0",
        "exit-0": "127",
        "stderr-0": "bash: line 1: toolchain: command not found",
      }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      ["make bootstrap"],
      ["pnpm typecheck"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.setupFailed).toBe(true);
    expect(collected.results).toEqual([]);
    expect(collected.failures).toEqual([
      {
        provider: "github",
        repoPath: "acme/web",
        command: "make bootstrap",
        exitCode: 127,
        stdout: "",
        stderr: "bash: line 1: toolchain: command not found",
        phase: "setup",
      },
    ]);
  });

  it("fails a check that exits 0 while reporting its dependencies are not installed", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        "stdout-0": "Yarn checks were blocked because dependencies are not installed",
      }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.results).toEqual([
      { provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 0 },
    ]);
    expect(collected.failures).toHaveLength(1);
    expect(collected.failures[0]!.stderr.toLowerCase()).toContain("did not actually run");
  });

  it("separates a workspace it could not enter from a setup command that failed", async () => {
    // Both stop the repository, but only one is the operator's configuration.
    // Reporting a vanished directory as setupFailed suppressed the fix cycles
    // of every other repository in the run, for a fault none of them caused.
    mockRunCommand.mockImplementation(batchOutputFiles(paths, { "stopped-at": "-1" }));

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.setupFailed).toBe(false);
    expect(collected.results).toEqual([]);
    // The phase is the mechanism: it is what excludes this failure from the
    // repair prompt and keeps it out of the run-wide setup suppression.
    expect(collected.failures[0]).toMatchObject({
      command: "(repository workspace)",
      phase: "workspace",
    });
    expect(collected.failures[0]!.stderr).toContain("not one of its");
    expect(collected.failures[0]!.stderr).toContain("/vercel/sandbox");
  });

  it("refuses output that belongs to a different launch", async () => {
    // Two wrappers sharing one directory would union their files into a set
    // that looks complete while no single process ran the batch end to end.
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { launch: "ffffffffffffffff", "exit-0": "0" }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.results).toEqual([]);
    expect(collected.setupFailed).toBe(false);
    expect(collected.failures[0]!.phase).toBe("workspace");
    expect(collected.failures[0]!.stderr).toContain("does not belong to the batch");
  });

  it("says the reader failed rather than blaming the launch marker", async () => {
    // The reader runs under `bash -lc`, which sources the very profile these
    // setup commands append to. Reporting that failure as "this output does not
    // belong to the batch that was launched for it" tells the operator their
    // checks ran under a foreign wrapper, and fails the gate as an unrepairable
    // workspace incident, for a broken shell profile.
    mockRunCommand.mockImplementation((cmd: unknown) =>
      batchReaderScript(cmd) === null
        ? commandResult(0, "")
        : commandResult(2, "", "/etc/profile.d/uv.sh: line 3: syntax error"),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.failures[0]!.stderr).toContain("could not be read back out of the Run");
    expect(collected.failures[0]!.stderr).not.toContain("does not belong to the batch");
    expect(collected.failures[0]!.phase).toBe("workspace");
  });

  it("says the wrapper never started when its marker is absent", async () => {
    // The wrapper writes the marker before it does anything else, so its
    // absence is a more informative diagnosis than the one the command loop
    // would reach a moment later ("exit-0 is missing").
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { launch: undefined }),
    );

    for (const batchFinished of [true, false]) {
      const collected = await collectRepoCheckBatchStep(
        "sbx-test-123",
        "github",
        "acme/web",
        [],
        ["pnpm typecheck"],
        paths,
        "/vercel/sandbox",
        batchFinished,
      );

      expect(collected.failures[0]!.stderr).toContain("never started");
      expect(collected.results).toEqual([]);
    }
  });

  it("reads no files at all from a sandbox that is no longer running", async () => {
    // This step is called on the path where the poll just gave up, having
    // observed the sandbox as not running twice. Its maxRetries is 0, so an SDK
    // error thrown here replaces the informative stall sentence with an
    // unclassified run failure, in the exact case the mechanism exists for.
    sandboxStatus = "stopped";
    mockRunCommand.mockImplementation(batchOutputFiles(paths, { "exit-0": "0" }));

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      paths,
      "/vercel/sandbox",
      false,
    );

    expect(collected.failures[0]!.stderr).toContain("no longer running");
    expect(collected.results).toEqual([]);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it("catches a blocked-dependency phrase that the truncation cuts in half", async () => {
    // The phrase the guard matches is `run \`yarn install\``, and head -c and
    // tail -c cut on bytes. A log long enough to be truncated puts the phrase
    // in the middle, where no amount of carried text can find it: the reader
    // greps the whole file instead, and the collector trusts that flag.
    const middle = `${"y".repeat(20_000)}error Yarn checks blocked: run \`yarn install\`${"z".repeat(20_000)}`;
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "exit-0": "0", "stdout-0": middle }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["yarn lint"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.failures).toHaveLength(1);
    expect(collected.failures[0]!.stderr).toContain("did not actually run");
    // The carried text really does not contain the phrase: the flag is what
    // caught it.
    expect(collected.failures[0]!.stdout).not.toContain("yarn install");
  });

  it("passes a green check whose output happens to name missing dependencies", async () => {
    // run_checks' explicit commands mode runs whatever an author typed and its
    // description promises nothing but the exit code. This repository's own
    // test names contain the phrase, so a scan there fails a green suite.
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        "stdout-0": "PASS installs when dependencies are not installed (12 tests)",
      }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm test"],
      paths,
      "/vercel/sandbox",
      true,
      false,
    );

    expect(collected.failures).toEqual([]);
    expect(collected.results).toEqual([
      { provider: "github", repoPath: "acme/web", command: "pnpm test", exitCode: 0 },
    ]);
  });

  it("still fails the same output when the configured checks asked for the scan", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        "stdout-0": "PASS installs when dependencies are not installed (12 tests)",
      }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm test"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.failures).toHaveLength(1);
  });

  it("treats an empty launch marker as a wrapper that never started", async () => {
    mockRunCommand.mockImplementation(batchOutputFiles(paths, { launch: "" }));

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.failures[0]!.stderr).toContain("never started");
    expect(collected.failures[0]!.stderr).not.toContain("does not belong");
  });

  it("reads the whole batch in one sandbox round trip", async () => {
    // Three reads per command inside a step whose maxRetries is 0 is the same
    // unbounded-await shape this change exists to remove, with a friendlier
    // constant: twenty commands would be sixty sequential round trips.
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        "exit-1": "0",
        "exit-2": "0",
        "exit-3": "0",
      }),
    );

    await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      ["make deps"],
      ["pnpm lint", "pnpm test", "pnpm typecheck"],
      paths,
      "/vercel/sandbox",
    );

    expect(mockRunCommand).toHaveBeenCalledTimes(1);
  });

  it("names where an abandoned batch stopped without inventing later results", async () => {
    // A stalled batch is collected too: those files are the only record of
    // which command it died on. The commands after it never started, so they
    // are not results of any kind.
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        "exit-1": "0",
        "stdout-2": "collecting tests...",
      }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      ["make deps"],
      ["pnpm lint", "uv run pytest tests/ -m integration", "pnpm typecheck"],
      paths,
      "/vercel/sandbox",
      false,
    );

    expect(collected.progress).toEqual({
      completed: 2,
      total: 4,
      stoppedAt: "uv run pytest tests/ -m integration",
    });
    expect(collected.results.map((result) => result.command)).toEqual(["pnpm lint"]);
    expect(collected.failures).toEqual([]);
  });

  it("keeps both ends of a long stream and names the bytes it dropped", async () => {
    // What this step returns is persisted in the run's event log, so a twenty
    // minute pytest log must never be carried back whole. Both ends survive
    // because tools disagree about where the answer is: tsc and mypy put the
    // root cause first, pytest puts the verdict last.
    const long = `FAILED_FIRST${"x".repeat(80_000)}FAILED test_end.py::test_last`;
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "exit-0": "1", "stderr-0": long }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm test"],
      paths,
      "/vercel/sandbox",
    );

    const stderr = collected.failures[0]!.stderr;
    expect(stderr).toContain("FAILED_FIRST");
    expect(stderr).toContain("FAILED test_end.py::test_last");
    expect(stderr).toContain(
      `[... ${long.length - 4_096} bytes of this command's output omitted ...]`,
    );
    // Sized against what a consumer shows (2000 characters), not against what
    // the event log tolerates: bytes past this are carried, persisted and then
    // thrown away unread.
    expect(stderr.length).toBeLessThanOrEqual(4_096 + 200);
  });

  it("bounds what one collect returns in total without erasing the last failure", async () => {
    // A dozen verbose failing commands multiply the per-stream bound, and all
    // of it lands in the run's event log as a step return value. Spending the
    // aggregate first-come, first-served would hand back the last failures
    // empty, and the last is as likely as any to be the one being read.
    const commands = Array.from({ length: 12 }, (_, index) => `pnpm test-${index}`);
    const files: Record<string, string> = {};
    for (let index = 0; index < commands.length; index++) {
      files[`exit-${index}`] = "1";
      files[`stderr-${index}`] = `START-${index}${"E".repeat(20_000)}END-${index}`;
    }
    mockRunCommand.mockImplementation(batchOutputFiles(paths, files));

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      commands,
      paths,
      "/vercel/sandbox",
    );

    const total = collected.failures.reduce(
      (sum, failure) => sum + failure.stdout.length + failure.stderr.length,
      0,
    );
    expect(collected.failures).toHaveLength(12);
    expect(total).toBeLessThanOrEqual(32 * 1024);
    // Every failure keeps both ends of its own output, the last one included.
    for (const [index, failure] of collected.failures.entries()) {
      expect(failure.stderr).toContain(`START-${index}`);
      expect(failure.stderr).toContain(`END-${index}`);
    }
  });

  it("never truncates the sentence that explains a failure", async () => {
    // The explanation is appended at the tail, so any bound that treats it as
    // payload drops it first and leaves an operator reading "Exit code: 0" in a
    // list titled failures with nothing saying why a zero exit is a failure.
    const commands = Array.from({ length: 12 }, (_, index) => `pnpm test-${index}`);
    const files: Record<string, string> = {};
    for (let index = 0; index < commands.length; index++) {
      files[`exit-${index}`] = "0";
      files[`stdout-${index}`] = `${"y".repeat(30_000)} dependencies are not installed`;
    }
    mockRunCommand.mockImplementation(batchOutputFiles(paths, files));

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      commands,
      paths,
      "/vercel/sandbox",
    );

    expect(collected.failures).toHaveLength(12);
    for (const failure of collected.failures) {
      expect(failure.exitCode).toBe(0);
      expect(failure.stderr).toContain("did not actually run");
    }
  });

  it("marks nothing when a stream fits inside the cap", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "exit-0": "1", "stderr-0": "2 tests failed" }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm test"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.failures[0]!.stderr).toBe("2 tests failed");
  });

  it("never reads a command with no recorded exit status as a pass", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "stdout-0": "half a test run" }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm test"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.results).toEqual([]);
    expect(collected.failures).toHaveLength(1);
    expect(collected.failures[0]).toMatchObject({ command: "pnpm test", exitCode: -1 });
    expect(collected.failures[0]!.stderr).toContain("interrupted");
  });
});

describe("startPrePrRepairStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("launches the repair wrapper detached instead of holding the command open", async () => {
    // A blocking launch keeps one sandbox ndjson stream open for the whole
    // repair agent. Production runs whose pre-PR checks crossed a function
    // invocation boundary lost that stream mid-flight, and the SDK's parse
    // error was reported as a launch that never produced a process: empty
    // output, empty logs, no exit code, for an agent that was in fact running.
    mockRunCommand.mockImplementation((cmd: unknown) => {
      if (isWrapperLaunch(cmd)) return detachedCommand();
      return commandResult(0, "");
    });

    const started = await startPrePrRepairStep(
      "sbx-test-123",
      "codex",
      "gpt-5",
      1,
      "github:acme/web\nCommand: pnpm typecheck\nType error on line 12",
    );

    expect(started).toMatchObject({
      ok: true,
      commandId: "cmd-detached",
      phase: "pre-pr-fix-1",
    });
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "bash",
        args: ["/tmp/pre-pr-fix-1-wrapper.sh"],
        cwd: "/vercel/sandbox",
        detached: true,
      }),
    );
    const prompt = mockWriteFiles.mock.calls[0]![0]
      .find((file: { path: string; content: Buffer }) => file.path.endsWith("requirements.md"))
      .content.toString();
    expect(prompt).toContain("github:acme/web");
    expect(prompt).toContain("Type error on line 12");
  });

  it("names the cause when the repair process cannot be launched at all", async () => {
    // Production runs died here with a failure that named only the boundary:
    // no exit code, no captured bytes, and the thrown error destroyed at the
    // catch. Every distinct launch cause has to reach the run record instead.
    const launchWith = (thrown: unknown) => {
      mockRunCommand.mockImplementation((cmd: unknown) => {
        if (isWrapperLaunch(cmd)) throw thrown;
        return commandResult(0, "");
      });
      return startPrePrRepairStep("sbx-test-123", "codex", "gpt-5", 1, "still failing");
    };

    const reset = await launchWith(new Error("sandbox connection reset"));
    expect(reset).toMatchObject({
      ok: false,
      failure: {
        diagnostic: {
          failureKind: "setup_failed",
          detail: expect.stringContaining("sandbox connection reset"),
        },
      },
    });

    const refused = await launchWith(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.failure.diagnostic.detail).toContain(
      "ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:443",
    );
  });

  it("bounds a very long launch failure cause instead of embedding it whole", async () => {
    const thrownMessage = "sandbox refused the launch. ".repeat(200);
    mockRunCommand.mockImplementation((cmd: unknown) => {
      if (isWrapperLaunch(cmd)) throw new Error(thrownMessage);
      return commandResult(0, "");
    });

    const started = await startPrePrRepairStep(
      "sbx-test-123",
      "codex",
      "gpt-5",
      1,
      "still failing",
    );

    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("unreachable");
    const detail = started.failure.diagnostic.detail ?? "";
    expect(detail).toContain("The Pre-PR repair process could not be launched:");
    expect(detail).not.toContain(thrownMessage);
    // Sentence plus the bound the repair cause is clamped to, and nothing more,
    // so a runaway error text cannot become the run status.
    expect(detail.length).toBeLessThanOrEqual(
      "The Pre-PR repair process could not be launched: ".length + 200,
    );
  });

  it("reports a wrapper that exited before it started as a launch failure", async () => {
    mockRunCommand.mockImplementation((cmd: unknown, args: unknown) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex");
      if (artifact) return artifact;
      if (isWrapperLaunch(cmd)) return commandResult(7, "", "boom");
      return commandResult(0, "");
    });

    const started = await startPrePrRepairStep(
      "sbx-test-123",
      "codex",
      "gpt-5",
      1,
      "still failing",
    );

    expect(started).toMatchObject({
      ok: false,
      failure: { diagnostic: { failureKind: "cli_exit", exitCode: 7 } },
    });
  });
});

describe("collectPrePrRepairStep", () => {
  const paths = {
    wrapper: "/tmp/pre-pr-fix-1-wrapper.sh",
    input: "/tmp/pre-pr-fix-1-requirements.md",
    stdout: "/tmp/pre-pr-fix-1-stdout.txt",
    stderr: "/tmp/pre-pr-fix-1-stderr.txt",
    exitCode: "/tmp/pre-pr-fix-1-exit-code",
    sentinel: "/tmp/pre-pr-fix-1-done",
    structuredOutput: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns authoritative Claude usage for a finished repair", async () => {
    const claudeOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      cost_usd: 0.42,
      duration_ms: 12_000,
      duration_api_ms: 10_000,
      num_turns: 2,
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
      },
    });
    mockRunCommand.mockImplementation((cmd: unknown, args: unknown) =>
      phaseArtifactCommand(cmd, args, "claude", claudeOutput) ?? commandResult(0, ""),
    );

    const collected = await collectPrePrRepairStep(
      "sbx-test-123",
      "claude",
      "pre-pr-fix-1",
      paths,
      "none",
      0,
    );

    expect(collected.failure).toBeUndefined();
    expect(collected.usage).toEqual({
      cost_usd: 0.42,
      tokens: { input: 120, cached_input: 30, output: 40 },
      duration_ms: 12_000,
      duration_api_ms: 10_000,
      num_turns: 2,
    });
  });

  it("returns null usage when the CLI output carries none", async () => {
    mockRunCommand.mockImplementation((cmd: unknown, args: unknown) =>
      phaseArtifactCommand(cmd, args, "codex") ?? commandResult(0, ""),
    );

    const collected = await collectPrePrRepairStep(
      "sbx-test-123",
      "codex",
      "pre-pr-fix-1",
      paths,
      "none",
      0,
    );

    expect(collected).toEqual({ usage: null });
  });

  it("keeps valid repair usage when malformed protocol output becomes a failure", async () => {
    const malformedWithUsage = [
      JSON.stringify({ type: "thread.started", thread_id: "normalized" }),
      "{malformed",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
      }),
    ].join("\n");
    mockRunCommand.mockImplementation((cmd: unknown, args: unknown) =>
      phaseArtifactCommand(cmd, args, "codex", malformedWithUsage) ?? commandResult(0, ""),
    );

    const collected = await collectPrePrRepairStep(
      "sbx-test-123",
      "codex",
      "pre-pr-fix-1",
      paths,
      "none",
      0,
    );

    expect(collected.failure).toMatchObject({
      category: "parsing",
      diagnostic: { failureKind: "invalid_json" },
    });
    expect(collected.usage).toEqual({
      cost_usd: null,
      tokens: { input: 8, cached_input: 2, output: 3 },
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
    });
  });

  it("distinguishes a repair that outlived its cap from a sandbox that died", async () => {
    const timedOut = await collectPrePrRepairStep(
      "sbx-test-123",
      "codex",
      "pre-pr-fix-1",
      paths,
      "timed_out",
      480_000,
    );
    const stopped = await collectPrePrRepairStep(
      "sbx-test-123",
      "codex",
      "pre-pr-fix-1",
      paths,
      "sandbox_stopped",
      480_000,
    );

    // The time that actually elapsed, never the 25 minute constant: the cap
    // that applies is the smaller of that constant and what is left of the
    // run's duration budget, so a run with eight minutes left is stopped at
    // eight and must not be told it got twenty-five.
    expect(timedOut.failure?.diagnostic.detail).toBe(
      "The Pre-PR repair process ran for 8 minutes without finishing and was stopped.",
    );
    expect(stopped.failure?.diagnostic.detail).toBe(
      "The sandbox stopped before the Pre-PR repair process finished.",
    );
    expect(timedOut.usage).toBeNull();
    // A stall never reads the sandbox back: there is nothing to collect.
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});

describe("boundFailureOutput", () => {
  it("keeps both ends of an oversized failure and names what it dropped", () => {
    const text = `HEAD${"m".repeat(5_000)}TAIL`;

    const bounded = boundFailureOutput(text, 2_000);

    expect(bounded.startsWith("HEAD")).toBe(true);
    expect(bounded.endsWith("TAIL")).toBe(true);
    expect(bounded).toContain(`[... ${text.length - 2_000} characters omitted ...]`);
    expect(bounded.length).toBe(2_000);
  });

  it("leaves output that already fits untouched", () => {
    expect(boundFailureOutput("2 tests failed", 2_000)).toBe("2 tests failed");
  });
});

function commandResult(exitCode: number, stdout = "", stderr = "") {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

/** Sandbox that serves the manifest and reports `head` for every rev-parse. */
function sandboxWithHead(head: string) {
  return (cmd: unknown, args: unknown) => {
    if (cmd === "cat" && Array.isArray(args) && args[0] === WORKSPACE_MANIFEST_PATH) {
      return commandResult(0, JSON.stringify(manifest));
    }
    if (cmd === "git") return commandResult(0, head);
    if (isWrapperLaunch(cmd)) return batchLaunch();
    return commandResult(0, "");
  };
}

/**
 * Serves one batch directory by running the collector's OWN reader script under
 * a real bash, against real files in a temporary directory.
 *
 * Deliberately not a JavaScript reimplementation of the reader. That script is
 * load-bearing (it decides whether a check passed, whether a batch ran at all,
 * and what an operator is shown), and a fake that reimplements it proves only
 * that the fake agrees with itself. Everything the collector suite covers,
 * present and missing and empty and oversized files, therefore exercises the
 * shell as written.
 *
 * The launch marker is served by default, because every collect checks it
 * first. A value of undefined means "this file does not exist".
 */
function batchOutputFiles(
  paths: RepoCheckBatchPaths,
  files: Record<string, string | undefined>,
) {
  const all: Record<string, string | undefined> = { launch: paths.launchId, ...files };
  return (cmd: unknown) => {
    const script = batchReaderScript(cmd);
    if (script === null) return commandResult(0, "");
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-batch-"));
    try {
      for (const [name, content] of Object.entries(all)) {
        if (content !== undefined) writeFileSync(join(dir, name), content);
      }
      // The collector built this script against its own /tmp path; point it at
      // the directory this test actually populated. Nothing else is rewritten.
      const stdout = execFileSync("bash", ["-lc", script.split(paths.dir).join(dir)], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return commandResult(0, stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** The reader is the one `bash -lc` call the collector makes. */
function batchReaderScript(cmd: unknown): string | null {
  const objectCommand = cmd as { cmd?: unknown; args?: unknown };
  if (typeof cmd !== "object" || cmd === null) return null;
  if (objectCommand.cmd !== "bash" || !Array.isArray(objectCommand.args)) return null;
  if (objectCommand.args[0] !== "-lc") return null;
  return typeof objectCommand.args[1] === "string" ? objectCommand.args[1] : null;
}

function phaseArtifactCommand(
  cmd: unknown,
  args: unknown,
  provider: "claude" | "codex",
  stdout = provider === "claude"
    ? JSON.stringify({ type: "result", subtype: "success", is_error: false })
    : JSON.stringify({ type: "turn.completed" }),
  phaseExitCode = 0,
) {
  if (cmd !== "cat" || !Array.isArray(args) || typeof args[0] !== "string") return null;
  const path = args[0];
  if (!path.startsWith("/tmp/pre-pr-fix-")) return null;
  if (path.endsWith("-stdout.txt")) return commandResult(0, stdout);
  if (path.endsWith("-stderr.txt")) return commandResult(0, "");
  if (path.endsWith("-exit-code")) return commandResult(0, String(phaseExitCode));
  if (path.endsWith("-result.json")) return commandResult(0, "repair complete");
  return null;
}

/** What a detached `runCommand` resolves to: the process is still running, so
 *  there is no exit code yet. */
function detachedCommand() {
  return {
    exitCode: null,
    cmdId: "cmd-detached",
    stdout: vi.fn().mockResolvedValue(""),
    stderr: vi.fn().mockResolvedValue(""),
  };
}

function batchLaunch() {
  return {
    exitCode: null,
    cmdId: "cmd-batch",
    stdout: vi.fn().mockResolvedValue(""),
    stderr: vi.fn().mockResolvedValue(""),
  };
}

function isWrapperLaunch(cmd: unknown): boolean {
  const objectCommand = cmd as { cmd?: unknown; args?: unknown };
  return (
    typeof cmd === "object" &&
    cmd !== null &&
    objectCommand.cmd === "bash" &&
    Array.isArray(objectCommand.args) &&
    typeof objectCommand.args[0] === "string" &&
    objectCommand.args[0].endsWith("-wrapper.sh")
  );
}
