import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  collectRepoCheckBatchStep,
  formatPrePrCheckFailures,
  listWorkspaceRepositoriesStep,
  parseBatchReaderOutput,
  repoCheckBatchPaths,
  setupMarkerPath,
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
    // Both signals, buried where neither the head slice nor the tail slice
    // reaches, which is what makes the whole-file grep load bearing.
    blocked: `${"y".repeat(9_000)}Yarn: dependencies are not installed. Run \`yarn install\` to run this command.${"z".repeat(9_000)}`,
    // One signal each, which our own green test suite really does print: its
    // test titles name the absent-dependencies message. Neither may fail a
    // check that exited 0.
    absenceOnly: "ok 12 - fails a check whose dependencies are not installed",
    installerOnly: "All 40 tests passed. Tip: run `pnpm install` after pulling.",
  };

  function read(profileNoise = "") {
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-reader-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
      }
      const script = buildBatchReaderScript({
        dir,
        names: [...Object.keys(files), "absent"],
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

  it("finds the blocked-dependency signals the truncation would have cut away", () => {
    const { parsed } = read();
    const blocked = parsed.get("blocked")!;

    expect(blocked.blocked).toBe(true);
    // Proof that only the whole-file grep could have found them: the message is
    // in neither end the reader carries back.
    expect(Buffer.from(blocked.head, "base64").toString()).not.toContain("yarn install");
    expect(Buffer.from(blocked.tail!, "base64").toString()).not.toContain("yarn install");
  });

  it("needs both signals, so a green suite that mentions one stays green", () => {
    const { parsed } = read();

    expect(parsed.get("absenceOnly")!.blocked).toBe(false);
    expect(parsed.get("installerOnly")!.blocked).toBe(false);
  });

  it("skips whatever the shell profile printed instead of absorbing it", () => {
    // The reader runs under `bash -lc`, which sources the profile our setup
    // commands append to. Without a token to match, output with no trailing
    // newline glues itself onto the first record and turns a batch that ran to
    // completion into "the wrapper never started".
    const { stdout, parsed } = read('printf "nvm: version 20.11.1";');

    expect(stdout.startsWith("nvm: version")).toBe(true);
    // Every record survives: the leading newline ends the profile's line, and
    // the marker means a line that is not a record is skipped rather than read
    // as a file called "nvm:".
    expect(parsed.get("present")).toBeDefined();
    expect(parsed.get("empty")).toBeDefined();
    expect(parsed.get("absent")).toBeDefined();
    expect([...parsed.keys()].sort()).toEqual([
      "absent",
      "absenceOnly",
      "blocked",
      "empty",
      "installerOnly",
      "oversized",
      "present",
    ].sort());
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
    if (started.skipped || started.envFailure) throw new Error("unreachable");
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

    // No commandGroups: a legacy configuration and the explicit-commands mode
    // both land in the single group a flat command list normalizes to.
    expect(collected.results).toEqual([
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm lint",
        exitCode: 1,
        group: "checks",
        durationMs: 0,
        timedOut: false,
      },
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm test",
        exitCode: 0,
        group: "checks",
        durationMs: 0,
        timedOut: false,
      },
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
        "stdout-0":
          "Yarn checks were blocked because dependencies are not installed. Run `yarn install`.",
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
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm typecheck",
        exitCode: 0,
        group: "checks",
        durationMs: 0,
        timedOut: false,
      },
    ]);
    expect(collected.failures).toHaveLength(1);
    expect(collected.failures[0]!.note!.toLowerCase()).toContain("did not actually run");
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

  it("catches blocked dependencies that the truncation cuts in half", async () => {
    // head -c and tail -c cut on bytes. A log long enough to be truncated puts
    // the message in the middle, where no amount of carried text can find it:
    // the reader greps the whole file instead, and the collector trusts that
    // flag.
    const middle = `${"y".repeat(20_000)}error Yarn: dependencies are not installed, run \`yarn install\`${"z".repeat(20_000)}`;
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
    // The reason travels as its own field, never folded into a stream where
    // the consumer's head-and-tail bound would delete it.
    expect(collected.failures[0]!.note).toContain("did not actually run");
    expect(collected.failures[0]!.stderr).toBe("");
    // The carried text really does not contain the message: the flag is what
    // caught it.
    expect(collected.failures[0]!.stdout).not.toContain("yarn install");
  });

  it("passes a green check that only mentions one of the two signals", async () => {
    // This repository's own test titles contain the absent-dependencies
    // sentence, so a single-signal scan fails our own green suite. Both modes
    // scan now, so the rule itself has to be the thing that does not fire.
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        "stdout-0": "PASS fails a check whose dependencies are not installed (12 tests)",
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

    expect(collected.failures).toEqual([]);
    expect(collected.results).toEqual([
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm test",
        exitCode: 0,
        group: "checks",
        durationMs: 0,
        timedOut: false,
      },
    ]);
  });

  it("gives every failure the same share, first and last alike", async () => {
    // A share computed from what is left over grows as the budget is spent, so
    // the FIRST failure got the smallest slice and the last the largest: at 16
    // failures, 1024 characters against 4153. The entry an operator reads first
    // must not be the most truncated one.
    const commands = Array.from({ length: 16 }, (_, index) => `pnpm test-${index}`);
    const files: Record<string, string> = {};
    for (let index = 0; index < commands.length; index++) {
      files[`exit-${index}`] = "1";
      files[`stderr-${index}`] = "E".repeat(20_000);
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

    const sizes = collected.failures.map((failure) => failure.stderr.length);
    expect(collected.failures).toHaveLength(16);
    expect(new Set(sizes).size).toBe(1);
  });

  it("gives an empty stream's half of the share to the other", async () => {
    // A fixed 50/50 split wastes half the share whenever a tool writes to one
    // stream, which is the common case: the failure keeps 1024 characters of a
    // 2048 share and the other half is spent on nothing.
    const commands = Array.from({ length: 16 }, (_, index) => `pnpm test-${index}`);
    const files: Record<string, string> = {};
    for (let index = 0; index < commands.length; index++) {
      files[`exit-${index}`] = "1";
      files[`stderr-${index}`] = "E".repeat(20_000);
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

    // 32768 / 16 is 2048, and stdout is empty, so stderr keeps the whole share.
    expect(collected.failures[0]!.stdout).toBe("");
    expect(collected.failures[0]!.stderr.length).toBeGreaterThan(2_000);
  });

  it("stops at the aggregate bound and says how many failures it left out", async () => {
    // Nothing bounds how many commands a repository may configure, and a floor
    // per failure means the aggregate grows with the count: 40 failing commands
    // returned 80 000 characters into the run's event log. The walk stops, and
    // what it dropped is stated rather than silently missing.
    const commands = Array.from({ length: 40 }, (_, index) => `pnpm test-${index}`);
    const files: Record<string, string> = {};
    for (let index = 0; index < commands.length; index++) {
      files[`exit-${index}`] = "1";
      files[`stderr-${index}`] = "E".repeat(20_000);
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

    const payload = collected.failures.reduce(
      (sum, failure) => sum + failure.stdout.length + failure.stderr.length,
      0,
    );
    expect(payload).toBeLessThanOrEqual(32 * 1024 + 2_000);
    expect(collected.failures.length).toBeLessThan(40);
    const last = collected.failures.at(-1)!;
    expect(last.phase).toBe("omitted");
    expect(last.note).toContain(
      `${40 - (collected.failures.length - 1)} further failing commands`,
    );
    // And the operator reads it, rather than counting entries to notice.
    const summary = formatPrePrCheckFailures(collected.failures);
    expect(summary).toContain("are not listed");
    // Named for what it is: this batch ran to the end, the report is what ran
    // out of room.
    expect(summary).toContain("FAILURES OMITTED for github:acme/web");
    expect(summary).not.toContain("CHECK BATCH ABANDONED");
  });

  it("reports a reader that lost its own output as a reader failure", async () => {
    // A login profile that redirects the shell's stdout (`exec 1>/dev/null`)
    // makes the reader exit 0 having emitted nothing. The reader always asks
    // for `launch`, and the script emits a record per name whether the file is
    // there or not, so zero records can only be the reader's own output being
    // lost. Calling it "the wrapper never started" sends the operator to look
    // at the wrapper.
    mockRunCommand.mockImplementation(() => commandResult(0, ""));

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.failures[0]!.stderr).toContain("could not be read");
    expect(collected.failures[0]!.stderr).not.toContain("never started");
    expect(collected.failures[0]!.phase).toBe("workspace");
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
    // The explanation travels as its own field. Folded into a stream it is
    // payload, and every consumer bounds the JOIN of the two streams head and
    // tail, which deletes exactly the boundary between them: an operator would
    // read "Exit code: 0" in a list titled failures with nothing saying why.
    const commands = Array.from({ length: 12 }, (_, index) => `pnpm test-${index}`);
    const files: Record<string, string> = {};
    for (let index = 0; index < commands.length; index++) {
      files[`exit-${index}`] = "0";
      files[`stdout-${index}`] =
        `${"y".repeat(30_000)} dependencies are not installed, run \`pnpm install\``;
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
      expect(failure.note).toContain("did not actually run");
    }
    // And it reaches the operator, after the output it explains rather than
    // inside it.
    const summary = formatPrePrCheckFailures(collected.failures);
    expect(summary.match(/did not actually run/g)).toHaveLength(12);
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
    expect(collected.failures[0]!.note).toContain("interrupted");
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

// ---------------------------------------------------------------------------
// Repository scripts: per-command timeouts, tree cleanliness, marker-gated
// setup, forwarded environment, and the typed per-group result contract.
// ---------------------------------------------------------------------------

describe("buildRepoCheckBatchScript, repository scripts", () => {
  const paths = repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd");

  it("bounds every command with a timeout and records how long it took", () => {
    const script = buildRepoCheckBatchScript({
      paths,
      localPath: "/vercel/sandbox",
      setup: [],
      commands: ["pnpm test"],
      commandTimeoutSeconds: 900,
      setupMarker: null,
    });

    // The bound is on the command, not on the batch: one hung command used to
    // burn the whole batch cap, and an abandoned batch says nothing about which
    // command hung.
    expect(script).toContain('timeout -k 5s 900s bash -lc "$2"');
    // Still exactly one dispatcher, so the login shell per command survives.
    expect(script.match(/bash -lc/g)).toHaveLength(1);
    expect(script).toContain(`${paths.dir}/duration-$1`);
  });

  it("gates setup on a marker file and writes the marker only after it succeeds", () => {
    const marker = "/tmp/aiw-setup-github__acme__web-0123456789ab";
    const script = buildRepoCheckBatchScript({
      paths,
      localPath: "/vercel/sandbox",
      setup: ["make bootstrap"],
      commands: ["pnpm test"],
      commandTimeoutSeconds: 600,
      setupMarker: marker,
    });

    expect(script).toContain(`if [ -f '${marker}' ]; then`);
    expect(script).toContain(`echo 1 > ${paths.dir}/setup-skipped`);
    // Written after the setup lines, so a setup that stopped the batch never
    // leaves a marker claiming the toolchain is provisioned.
    const markerWrite = script.indexOf(`touch '${marker}'`);
    expect(markerWrite).toBeGreaterThan(script.indexOf("run_pre_pr_command 0 'make bootstrap'"));
  });

  it("records what the commands left behind and puts tracked files back", () => {
    const script = buildRepoCheckBatchScript({
      paths,
      localPath: "/vercel/sandbox",
      setup: [],
      commands: ["pnpm test"],
      commandTimeoutSeconds: 600,
      setupMarker: null,
    });

    expect(script).toContain("git status --porcelain=v1 --untracked-files=no");
    expect(script).toContain("git checkout -- .");
    expect(script).toContain(`${paths.dir}/dirty`);
  });
});

describe("setupMarkerPath", () => {
  // The marker decides whether a repository's provisioning is skipped, so its
  // stability IS the contract: a hash that moved between two identical batches
  // silently re-runs setup forever, and a hash that did NOT move after the
  // setup array changed keeps claiming an old toolchain is installed.
  it("is the same path for the same setup array", async () => {
    await expect(setupMarkerPath("github__acme__web", ["make bootstrap"])).resolves.toBe(
      "/tmp/aiw-setup-github__acme__web-cb5b72352f2b",
    );
    await expect(setupMarkerPath("github__acme__web", ["make bootstrap"])).resolves.toBe(
      "/tmp/aiw-setup-github__acme__web-cb5b72352f2b",
    );
  });

  it("moves when the setup array changes, and separates two repositories", async () => {
    await expect(
      setupMarkerPath("github__acme__web", ["make bootstrap", "uv sync"]),
    ).resolves.toBe("/tmp/aiw-setup-github__acme__web-f6ebbde4549d");
    // Order is part of the identity: setup runs in sequence, so the same two
    // commands the other way round are not the same provisioning.
    await expect(setupMarkerPath("github__acme__web", ["uv sync"])).resolves.toBe(
      "/tmp/aiw-setup-github__acme__web-0cae1aefdc9e",
    );
    // Same setup, different repository: the marker is per workspace directory,
    // because provisioning one repository says nothing about another.
    await expect(setupMarkerPath("gitlab__acme__api", ["make bootstrap"])).resolves.toBe(
      "/tmp/aiw-setup-gitlab__acme__api-cb5b72352f2b",
    );
  });

  it("is the path the start step actually writes into the wrapper", async () => {
    vi.clearAllMocks();
    mockRunCommand.mockImplementation(sandboxWithHead("web-head"));

    await startRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      ["make bootstrap"],
      ["pnpm test"],
      0,
      0,
    );

    const wrapper = mockWriteFiles.mock.calls[0]![0][0].content.toString();
    expect(wrapper).toContain("/tmp/aiw-setup-github__acme__web-cb5b72352f2b");
  });
});

describe("the batch script under a real bash", () => {
  // Deliberately executed rather than string-matched, for the same reason the
  // batch reader is: this script decides whether a check passed, whether the
  // tree survived it, and whether provisioning is skipped, and a JavaScript
  // model of it proves only that the model agrees with itself. It caught a real
  // one: an arithmetic expansion error is fatal to the compound command around
  // it, so an unguarded duration measurement silently skipped the marker write.
  const hasTools = ((): boolean => {
    try {
      execFileSync("bash", ["-lc", "command -v timeout >/dev/null && command -v git >/dev/null"]);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasTools)(
    "times out a command, records the dirt, restores the tree and gates setup",
    () => {
      const root = mkdtempSync(join(tmpdir(), "aiw-batch-"));
      const repo = join(root, "repo");
      try {
        execFileSync("mkdir", ["-p", repo]);
        execFileSync("git", ["init", "-q", repo]);
        writeFileSync(join(repo, "tracked.txt"), "original\n");
        execFileSync("git", ["-C", repo, "add", "."]);
        execFileSync("git", [
          "-C",
          repo,
          "-c",
          "user.email=a@b.c",
          "-c",
          "user.name=t",
          "commit",
          "-qm",
          "init",
        ]);

        const paths = {
          ...repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd"),
          dir: join(root, "batchdir"),
          wrapper: join(root, "wrapper.sh"),
          sentinel: join(root, "done"),
        };
        const marker = join(root, ".aiw-setup-x-abc");
        writeFileSync(
          paths.wrapper,
          buildRepoCheckBatchScript({
            paths,
            localPath: repo,
            setup: ["true"],
            commands: ["echo hi", "sleep 5", "echo dirtied > tracked.txt"],
            commandTimeoutSeconds: 1,
            setupMarker: marker,
          }),
        );
        const read = (name: string): string | null =>
          existsSync(join(paths.dir, name))
            ? readFileSync(join(paths.dir, name), "utf8").trim()
            : null;

        execFileSync("bash", ["-n", paths.wrapper]);
        execFileSync("bash", [paths.wrapper]);

        expect(existsSync(paths.sentinel)).toBe(true);
        expect(read("launch")).toBe("aaaabbbbccccdddd");
        expect(read("exit-0")).toBe("0");
        expect(read("exit-1")).toBe("0");
        // The whole point of the per-command bound: a command that outlives it
        // is killed and reported, and the batch keeps going.
        expect(read("exit-2")).toBe("124");
        expect(read("exit-3")).toBe("0");
        // A number, whatever it is: a `date` without %N reports 0 rather than
        // taking the wrapper down with it.
        expect(read("duration-1")).toMatch(/^-?\d+$/);
        // The third command edited a tracked file. It is named, and put back.
        expect(read("dirty")).toBe("tracked.txt");
        expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
        expect(existsSync(marker)).toBe(true);

        // Second batch, same setup: the marker is there, so provisioning is
        // skipped and the skip is recorded for the collector.
        rmSync(paths.dir, { recursive: true, force: true });
        execFileSync("bash", [paths.wrapper]);
        expect(read("setup-skipped")).toBe("1");
        expect(read("exit-0")).toBe(null);
        expect(read("exit-1")).toBe("0");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasTools)(
    "restores only what its own commands dirtied, and never the agent's work",
    () => {
      // The data loss this closes. The first version ran `git checkout -- .`
      // over the whole worktree, which reverts everything uncommitted, in a
      // workspace where uncommitted agent work is the normal state between an
      // implementation phase and its commit. A run whose checks merely touched
      // a lockfile would have thrown the implementation away and then reported
      // a green batch over it.
      const root = mkdtempSync(join(tmpdir(), "aiw-restore-"));
      const repo = join(root, "repo");
      try {
        execFileSync("mkdir", ["-p", repo]);
        execFileSync("git", ["init", "-q", repo]);
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=t", ...args]);
        for (const name of ["agent-work.ts", "agent-staged.ts", "checked.ts", "formatted.ts"]) {
          writeFileSync(join(repo, name), "committed\n");
        }
        git("add", ".");
        git("commit", "-qm", "init");

        // What the agent left behind before the batch starts: one unstaged
        // edit and one staged edit. Neither may be touched.
        writeFileSync(join(repo, "agent-work.ts"), "agent implementation\n");
        writeFileSync(join(repo, "agent-staged.ts"), "agent staged work\n");
        git("add", "agent-staged.ts");

        const paths = {
          ...repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd"),
          dir: join(root, "batchdir"),
          wrapper: join(root, "wrapper.sh"),
          sentinel: join(root, "done"),
        };
        writeFileSync(
          paths.wrapper,
          buildRepoCheckBatchScript({
            paths,
            localPath: repo,
            setup: [],
            commands: [
              // Dirt this batch causes, one unstaged and one staged, because
              // `git checkout -- <file>` would leave the staged copy behind.
              "echo rewritten-by-check > formatted.ts",
              "echo staged-by-check > checked.ts && git add checked.ts",
            ],
            commandTimeoutSeconds: 30,
            setupMarker: null,
          }),
        );
        const read = (name: string): string | null =>
          existsSync(join(paths.dir, name))
            ? readFileSync(join(paths.dir, name), "utf8").trim()
            : null;
        const file = (name: string): string => readFileSync(join(repo, name), "utf8");

        execFileSync("bash", [paths.wrapper]);

        // The agent's work is exactly as it was, staged copy included.
        expect(file("agent-work.ts")).toBe("agent implementation\n");
        expect(file("agent-staged.ts")).toBe("agent staged work\n");
        expect(
          execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], {
            encoding: "utf8",
          }).trim(),
        ).toBe("agent-staged.ts");

        // What the commands did is undone, whether they staged it or not.
        expect(file("formatted.ts")).toBe("committed\n");
        expect(file("checked.ts")).toBe("committed\n");

        // And the two lists are kept apart, so a caller can tell dirt the run
        // caused from dirt it inherited.
        expect(read("dirty")!.split("\n").sort()).toEqual(["checked.ts", "formatted.ts"]);
        expect(read("dirty-before")!.split("\n").sort()).toEqual([
          "agent-staged.ts",
          "agent-work.ts",
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasTools)("leaves the tree edited when the selection turns restore off", () => {
    // A group whose job is to edit the tree (a formatter run with --write)
    // keeps its output. It is still recorded, so the run knows what moved.
    const root = mkdtempSync(join(tmpdir(), "aiw-norestore-"));
    const repo = join(root, "repo");
    try {
      execFileSync("mkdir", ["-p", repo]);
      execFileSync("git", ["init", "-q", repo]);
      writeFileSync(join(repo, "formatted.ts"), "committed\n");
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", [
        "-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init",
      ]);

      const paths = {
        ...repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd"),
        dir: join(root, "batchdir"),
        wrapper: join(root, "wrapper.sh"),
        sentinel: join(root, "done"),
      };
      writeFileSync(
        paths.wrapper,
        buildRepoCheckBatchScript({
          paths,
          localPath: repo,
          setup: [],
          commands: ["echo formatted > formatted.ts"],
          commandTimeoutSeconds: 30,
          setupMarker: null,
          restoreTree: false,
        }),
      );

      execFileSync("bash", [paths.wrapper]);

      expect(readFileSync(join(repo, "formatted.ts"), "utf8")).toBe("formatted\n");
      expect(readFileSync(join(paths.dir, "dirty"), "utf8").trim()).toBe("formatted.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasTools)("records a setup marker it could not write", () => {
    // Not a failure: the batch is correct, it is only slower, because every
    // later batch in this sandbox re-runs provisioning. Silence would leave
    // nobody able to find out why.
    const root = mkdtempSync(join(tmpdir(), "aiw-marker-"));
    const repo = join(root, "repo");
    try {
      execFileSync("mkdir", ["-p", repo]);
      execFileSync("git", ["init", "-q", repo]);

      const paths = {
        ...repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd"),
        dir: join(root, "batchdir"),
        wrapper: join(root, "wrapper.sh"),
        sentinel: join(root, "done"),
      };
      writeFileSync(
        paths.wrapper,
        buildRepoCheckBatchScript({
          paths,
          localPath: repo,
          setup: ["true"],
          commands: ["echo hi"],
          commandTimeoutSeconds: 30,
          setupMarker: join(root, "no-such-directory", "marker"),
        }),
      );

      execFileSync("bash", [paths.wrapper]);

      expect(readFileSync(join(paths.dir, "setup-marker-failed"), "utf8").trim()).toBe("1");
      // The batch itself is unharmed: setup ran, the check ran, it finished.
      expect(readFileSync(join(paths.dir, "exit-0"), "utf8").trim()).toBe("0");
      expect(readFileSync(join(paths.dir, "exit-1"), "utf8").trim()).toBe("0");
      expect(existsSync(paths.sentinel)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasTools)("survives a `date` with no %N instead of losing the batch", () => {
    // The regression this pins, found by running the wrapper on a BSD date: an
    // arithmetic expansion error is fatal to the COMPOUND COMMAND it sits in,
    // not just to the line. An unguarded `$(( $(date +%s%3N) - ... ))` inside
    // run_pre_pr_command therefore aborted the whole enclosing if-block, and
    // the setup marker at the end of it was silently never written. Stubbed
    // rather than relied on: on Linux CI `date` does implement %N, so without
    // this the guard has no coverage at all.
    const root = mkdtempSync(join(tmpdir(), "aiw-nodate-"));
    const repo = join(root, "repo");
    try {
      execFileSync("mkdir", ["-p", join(root, "bin")]);
      execFileSync("mkdir", ["-p", repo]);
      execFileSync("git", ["init", "-q", repo]);
      writeFileSync(join(root, "bin", "date"), "#!/bin/sh\necho 1787297474N\n");
      execFileSync("chmod", ["+x", join(root, "bin", "date")]);

      const paths = {
        ...repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd"),
        dir: join(root, "batchdir"),
        wrapper: join(root, "wrapper.sh"),
        sentinel: join(root, "done"),
      };
      const marker = join(root, ".aiw-setup-x-abc");
      writeFileSync(
        paths.wrapper,
        buildRepoCheckBatchScript({
          paths,
          localPath: repo,
          setup: ["true"],
          commands: ["echo hi"],
          commandTimeoutSeconds: 30,
          setupMarker: marker,
        }),
      );
      const read = (name: string): string | null =>
        existsSync(join(paths.dir, name))
          ? readFileSync(join(paths.dir, name), "utf8").trim()
          : null;

      execFileSync("bash", [paths.wrapper], {
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` },
      });

      // Every one of these is what the unguarded version lost.
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(paths.sentinel)).toBe(true);
      expect(read("exit-0")).toBe("0");
      expect(read("exit-1")).toBe("0");
      // 0 means "not measured", and the collector reads it as such.
      expect(read("duration-1")).toBe("0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("startRepoCheckBatchStep, forwarded environment", () => {
  const originalAllowlist = process.env.PRE_PR_CHECKS_ALLOWED_ENV;
  const originalSecret = process.env.AIW_TEST_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PRE_PR_CHECKS_ALLOWED_ENV;
    delete process.env.AIW_TEST_TOKEN;
  });

  afterAll(() => {
    if (originalAllowlist === undefined) delete process.env.PRE_PR_CHECKS_ALLOWED_ENV;
    else process.env.PRE_PR_CHECKS_ALLOWED_ENV = originalAllowlist;
    if (originalSecret === undefined) delete process.env.AIW_TEST_TOKEN;
    else process.env.AIW_TEST_TOKEN = originalSecret;
  });

  it("forwards an allowlisted value through the launch and never into the script", async () => {
    process.env.PRE_PR_CHECKS_ALLOWED_ENV = "AIW_TEST_TOKEN, OTHER";
    process.env.AIW_TEST_TOKEN = "s3cr3t-value";
    mockRunCommand.mockImplementation(sandboxWithHead("web-head"));

    const started = await startRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm test"],
      0,
      0,
      true,
      { envNames: ["AIW_TEST_TOKEN"] },
    );

    expect(started.skipped).toBe(false);
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({ detached: true, env: { AIW_TEST_TOKEN: "s3cr3t-value" } }),
    );
    // The value reaches the process through the SDK, never through a file the
    // sandbox keeps or a step return value the event log persists.
    const wrapper = mockWriteFiles.mock.calls[0]![0][0].content.toString();
    expect(wrapper).not.toContain("s3cr3t-value");
  });

  it("refuses a variable the operator never allowlisted, and starts nothing", async () => {
    process.env.AIW_TEST_TOKEN = "s3cr3t-value";
    mockRunCommand.mockImplementation(sandboxWithHead("web-head"));

    const started = await startRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm test"],
      0,
      0,
      true,
      { envNames: ["AIW_TEST_TOKEN"] },
    );

    if (started.skipped || !started.envFailure) throw new Error("expected an env failure");
    expect(started.envFailure.phase).toBe("env");
    expect(started.envFailure.stderr).toContain("AIW_TEST_TOKEN");
    expect(started.envFailure.stderr).toContain("PRE_PR_CHECKS_ALLOWED_ENV");
    // Names only. A refusal that quotes the value defeats the whole point.
    expect(started.envFailure.stderr).not.toContain("s3cr3t-value");
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it("refuses a variable that is allowlisted but unset in the worker", async () => {
    process.env.PRE_PR_CHECKS_ALLOWED_ENV = "AIW_TEST_TOKEN";
    mockRunCommand.mockImplementation(sandboxWithHead("web-head"));

    const started = await startRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm test"],
      0,
      0,
      true,
      { envNames: ["AIW_TEST_TOKEN"] },
    );

    if (started.skipped || !started.envFailure) throw new Error("expected an env failure");
    expect(started.envFailure.stderr).toContain("AIW_TEST_TOKEN");
    expect(started.envFailure.stderr).toContain("not set");
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });
});

describe("collectRepoCheckBatchStep, repository scripts", () => {
  const paths = repoCheckBatchPaths(0, 0, "aaaabbbbccccdddd");
  const originalAllowlist = process.env.PRE_PR_CHECKS_ALLOWED_ENV;
  const originalSecret = process.env.AIW_TEST_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    sandboxStatus = "running";
    delete process.env.PRE_PR_CHECKS_ALLOWED_ENV;
    delete process.env.AIW_TEST_TOKEN;
  });

  afterAll(() => {
    if (originalAllowlist === undefined) delete process.env.PRE_PR_CHECKS_ALLOWED_ENV;
    else process.env.PRE_PR_CHECKS_ALLOWED_ENV = originalAllowlist;
    if (originalSecret === undefined) delete process.env.AIW_TEST_TOKEN;
    else process.env.AIW_TEST_TOKEN = originalSecret;
  });

  it("tags every result with its group and how long it took", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        "duration-0": "4200",
        "exit-1": "0",
        "duration-1": "17",
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
      true,
      { commandGroups: ["lint", "test"] },
    );

    expect(collected.results).toEqual([
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm lint",
        exitCode: 0,
        group: "lint",
        durationMs: 4200,
        timedOut: false,
      },
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm test",
        exitCode: 0,
        group: "test",
        durationMs: 17,
        timedOut: false,
      },
    ]);
  });

  it("reports a command the per-command timeout killed as timed out, not merely failed", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "exit-0": "124", "duration-0": "600123" }),
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
      { commandGroups: ["test"], commandTimeoutMinutes: 10 },
    );

    expect(collected.results[0]).toMatchObject({ timedOut: true, durationMs: 600123 });
    expect(collected.failures[0]!.note).toContain("timed out after 10 minutes");
  });

  it("calls an early exit 124 an ordinary failure, because 124 is a legal exit code", async () => {
    // A command is free to exit 124 on its own, and plenty do (`timeout` inside
    // a test script, a runner that forwards its child's code). Believing the
    // code alone would tell an operator to raise a bound that was never
    // reached, and would hide a real failure behind "neither passed nor
    // failed". The duration has to corroborate it.
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "124",
        "duration-0": "40000",
        "stderr-0": "2 tests failed",
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
      { commandGroups: ["test"], commandTimeoutMinutes: 10 },
    );

    expect(collected.results[0]).toMatchObject({ timedOut: false, durationMs: 40000 });
    expect(collected.failures[0]!.note ?? "").not.toContain("timed out");
    expect(collected.failures[0]!.stderr).toContain("2 tests failed");
  });

  it("treats a duration just inside the teardown margin as a timeout", async () => {
    // `timeout` fires at the bound, then the process still has to die, so the
    // measured duration lands a little under it. The margin is what keeps a
    // genuine timeout from being demoted to a failure by a few milliseconds.
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "exit-0": "124", "duration-0": "540000" }),
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
      { commandGroups: ["test"], commandTimeoutMinutes: 10 },
    );

    expect(collected.results[0]).toMatchObject({ timedOut: true });
  });

  it("keeps inherited dirt apart from the dirt the batch caused", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        dirty: "pnpm-lock.yaml\n",
        "dirty-before": "src/feature.ts\nsrc/feature.test.ts\n",
      }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm install"],
      paths,
      "/vercel/sandbox",
      true,
      { commandGroups: ["deps"] },
    );

    expect(collected.dirtied).toEqual(["pnpm-lock.yaml"]);
    expect(collected.preExistingDirty).toEqual(["src/feature.ts", "src/feature.test.ts"]);
  });

  it("reports a setup marker the sandbox refused to write", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "exit-0": "0", "exit-1": "0", "setup-marker-failed": "1" }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      ["pnpm install"],
      ["pnpm test"],
      paths,
      "/vercel/sandbox",
      true,
      { commandGroups: ["test"] },
    );

    // Not a failure. Provisioning worked; only the "do not do it again" note
    // did not stick, so every later batch pays for setup a second time.
    expect(collected.setupMarkerFailed).toBe(true);
    expect(collected.failures).toEqual([]);
  });

  it("scrubs a forwarded value out of everything it hands back", async () => {
    process.env.PRE_PR_CHECKS_ALLOWED_ENV = "AIW_TEST_TOKEN";
    process.env.AIW_TEST_TOKEN = "s3cr3t-value";
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "1",
        "stderr-0": "auth failed with token s3cr3t-value while cloning",
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
      { commandGroups: ["test"], envNames: ["AIW_TEST_TOKEN"] },
    );

    expect(collected.failures[0]!.stderr).toContain("[redacted:AIW_TEST_TOKEN]");
    expect(collected.failures[0]!.stderr).not.toContain("s3cr3t-value");
  });

  it("leaves no byte of a value the sandbox reader cut in half", async () => {
    // The leak this closes. The reader carries back a 2048 byte head and a 2048
    // byte tail of an oversized stream, so a value straddling either cut edge
    // arrives already halved, and a whole-string replace cannot find a half.
    // The fragment would then be persisted in the event log and printed in the
    // run summary. Both edges are built here on purpose: the head slice ENDS
    // mid-value, the tail slice STARTS mid-value.
    const secret = "SECRETVALUE123456789";
    process.env.PRE_PR_CHECKS_ALLOWED_ENV = "AIW_TEST_TOKEN";
    process.env.AIW_TEST_TOKEN = secret;
    const stream = [
      "A".repeat(2_040),
      secret, // bytes 2040..2060: the head cut at 2048 splits it after "SECRETVA"
      "M".repeat(5_000), // the omitted middle, which never leaves the sandbox
      secret, // the tail cut at 2048 from the end splits it before "23456789"
      "B".repeat(2_040),
    ].join("");
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "exit-0": "1", "stdout-0": stream }),
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
      { commandGroups: ["test"], envNames: ["AIW_TEST_TOKEN"] },
    );

    const stdout = collected.failures[0]!.stdout;
    // The exact fragments the two cuts produce, named as literals so a
    // regression cannot pass by redacting something else.
    expect(stdout).not.toContain("SECRETVA");
    expect(stdout).not.toContain("23456789");
    expect(stdout).not.toContain(secret);
    // Not one character of it anywhere, whatever the shape of the cut.
    for (let length = 4; length <= secret.length; length++) {
      expect(stdout).not.toContain(secret.slice(0, length));
      expect(stdout).not.toContain(secret.slice(secret.length - length));
    }
    // Both edges say what was removed, rather than silently swallowing it.
    expect(stdout.split("[redacted:AIW_TEST_TOKEN]")).toHaveLength(3);
    // The surrounding output is untouched: the fragment scrub is anchored to
    // the cut edges and must not eat ordinary text.
    expect(stdout).toContain("A".repeat(2_040));
    expect(stdout).toContain("B".repeat(2_040));
  });

  it("surfaces the tracked files a repository's commands left behind", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, {
        "exit-0": "0",
        dirty: "src/generated.ts\npnpm-lock.yaml",
      }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm build"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.dirtied).toEqual(["src/generated.ts", "pnpm-lock.yaml"]);
  });

  it("reads a marker-skipped setup as satisfied, never as a command that vanished", async () => {
    mockRunCommand.mockImplementation(
      batchOutputFiles(paths, { "setup-skipped": "1", "exit-1": "0" }),
    );

    const collected = await collectRepoCheckBatchStep(
      "sbx-test-123",
      "github",
      "acme/web",
      ["make bootstrap"],
      ["pnpm test"],
      paths,
      "/vercel/sandbox",
    );

    expect(collected.setupFailed).toBe(false);
    expect(collected.failures).toEqual([]);
    expect(collected.results).toHaveLength(1);
    expect(collected.progress).toEqual({ completed: 2, total: 2, stoppedAt: null });
  });
});

describe("the repair machinery", () => {
  it("is gone: a repository script batch can no longer launch an agent", async () => {
    const runner = await import("./runner.js");

    expect(runner).not.toHaveProperty("startPrePrRepairStep");
    expect(runner).not.toHaveProperty("collectPrePrRepairStep");
    expect(runner.MAX_PRE_PR_FIX_CYCLES).toBe(0);
  });
});
