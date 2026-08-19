import type { Command as SandboxCommand } from "@vercel/sandbox";
import { getSandboxCredentials } from "../sandbox/credentials.js";
import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_ROOT_DIR,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "../sandbox/repo-workspace.js";
import type {
  AgentProtocolResult,
  CollectedPhaseArtifacts,
  PhaseArtifactPaths,
  PhaseUsage,
  RunnableSandbox,
} from "../sandbox/agents/types.js";
import type { TokenPrice } from "../sandbox/agents/pricing.js";
import type { ResolvedHarnessRuntime } from "../sandbox/harness-runtime.js";
import type {
  RunBudgetFailure,
  RunBudgetLimits,
  RunBudgetState,
} from "../workflows/run-budget.js";

export const MAX_PRE_PR_FIX_CYCLES = 3;

/** Longest launch cause carried into the Pre-PR repair failure detail. Same
 *  bound the workspace gate puts on a carried inspection reason (AIW-223): long
 *  enough for a connection or spawn verdict, short enough that the composed
 *  sentence stays a failure detail rather than a payload. */
const PRE_PR_LAUNCH_CAUSE_MAX_LENGTH = 200;

/**
 * Ceiling on one repository's detached check batch, in minutes.
 *
 * A ceiling only. The bound that actually applies is the smaller of this and
 * the run's remaining duration budget, computed per batch by
 * effectiveBatchCapMinutes in workflows/blocks/pre-pr-checks.ts, because the
 * duration budget is not a constant: it is `maxDurationMs` from the definition
 * when the plan sets one, and otherwise env.JOB_TIMEOUT_MS, whose schema
 * default is 1_800_000 (30 minutes) while our production deployment runs
 * 6_000_000 (100 minutes). So 60 is reachable on production and unreachable on
 * a default deployment, and nothing may state it as the bound that applied.
 *
 * It is deliberately far above the 300s a Vercel function invocation gets,
 * because that limit is what this whole launch/poll/collect shape exists to
 * escape: a client tenant's `uv sync` plus linters plus mypy plus pytest is
 * roughly 19 minutes of real work, and running it inside one step invocation
 * killed the run mid-await with no recoverable cause.
 */
export const PRE_PR_CHECK_BATCH_MAX_MINUTES = 60;

/** Ceiling on one Pre-PR repair agent, matching the 25 minutes every other
 *  agent phase gets (DEFAULT_MAX_MINUTES in workflows/blocks/fix-agent.ts). */
export const PRE_PR_REPAIR_MAX_MINUTES = 25;

export interface PrePrCheckFailure {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Why this failure is reported, when the command's own output does not say
   * it. Rendered on its own line, never folded into a stream.
   *
   * Folding it in makes it payload, and payload is what truncation eats: every
   * consumer bounds the JOIN of the two streams head-and-tail, so a note
   * appended to stderr sits exactly at the boundary between them, which is the
   * middle that a head-and-tail bound deletes. An operator then reads
   * `Exit code: 0` under a heading that says failures with nothing anywhere
   * saying why a zero exit failed.
   */
  note?: string;
  /**
   * Set when the entry is not an ordinary check result.
   *
   * `setup` is an authored provisioning command that failed: the workspace
   * could not be provisioned, which no code edit can repair, and the operator
   * has a command to fix. `workspace` is the run's own workspace failing the
   * repository (its directory unreachable, or its output files not belonging to
   * the launch being collected): nothing about it is authored configuration, so
   * it must never be reported as a setup command the operator should go and fix.
   * `batch` is the batch itself never reporting (it outlived its bound, or its
   * sandbox went), which is neither a command's result nor a repairable one.
   * `omitted` is this collect running out of aggregate budget: one entry
   * standing for the failures it could not carry.
   *
   * Everything with a phase is excluded from the repair prompt, and from the
   * sentences that only make sense for an ordinary failing check.
   */
  phase?: "setup" | "workspace" | "batch" | "omitted";
}

export type CheckOutcome =
  | "passed"
  | "failed"
  | "skipped"
  | "missing_configuration";

export interface PrePrCheckCommandResult {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  command: string;
  exitCode: number;
}

export interface PrePrCheckRunResult {
  outcome: Exclude<CheckOutcome, "skipped">;
  passed: boolean;
  fixCycles: number;
  /** One entry per launched fixer; null means the CLI returned no authoritative usage. */
  fixCycleUsages: Array<PhaseUsage | null>;
  budgetFailure: RunBudgetFailure | null;
  /** Every normally started command, in workspace/repository and authored command order. */
  results: PrePrCheckCommandResult[];
  failures: PrePrCheckFailure[];
  /** True when at least one repository's setup phase failed. Suppresses fix cycles. */
  setupFailed: boolean;
  summary: string;
  /** Runtime/protocol failure from a launched repair agent. */
  agentFailure?: Extract<AgentProtocolResult<unknown>, { ok: false }>;
}

export interface PrePrFixBudgetContext {
  state: RunBudgetState;
  limits: RunBudgetLimits;
  price: TokenPrice | null;
}

type SandboxSession = RunnableSandbox;

/** Where one repository's detached check batch keeps its wrapper, its
 *  per-command output files and its completion sentinel. */
export interface RepoCheckBatchPaths {
  /**
   * Identity of the one launch these paths belong to.
   *
   * A cycle and repository pair is not a unique launch. If two wrappers ever
   * share a path set, their output files union into a set that looks complete
   * while no single process ran the batch end to end, and the collector reads
   * a green result no run ever produced. Agent phases already key their
   * artifacts by attempt for the same reason (phaseKey in workflows/agent.ts).
   * A false pass on the pre-PR gate is the worst outcome this system has, so
   * the identity is in the path AND written inside the directory, and the
   * collector checks it.
   */
  launchId: string;
  /** Holds `launch`, `stdout-<i>`, `stderr-<i>`, `exit-<i>` and, when the batch
   *  stopped early, `stopped-at`. One file per command: a single delimited
   *  transcript would have to be parsed back apart, and that parser is a bug
   *  farm. */
  dir: string;
  wrapper: string;
  sentinel: string;
}

/**
 * Marker written to `stopped-at` when the wrapper could not even enter the
 * repository directory, so a batch that produced no command result at all is
 * reported as such instead of being read as a silent pass.
 */
const BATCH_NO_COMMAND_RAN = -1;

export function repoCheckBatchPaths(
  fixCycle: number,
  repoIndex: number,
  launchId: string,
): RepoCheckBatchPaths {
  // Namespaced by fix cycle so cycle N never reads cycle N-1's output files, by
  // repository so two repositories cannot collide, and by launch so two
  // wrappers for the same repository and cycle cannot either.
  const id = `pre-pr-checks-c${fixCycle}-r${repoIndex}-${launchId}`;
  return {
    launchId,
    dir: `/tmp/${id}`,
    wrapper: `/tmp/${id}-wrapper.sh`,
    sentinel: `/tmp/${id}-done`,
  };
}

/**
 * Filename-safe identity for one wrapper launch. Generated inside the start
 * step, so the value a replay sees is the one the recorded step returned, while
 * a body that genuinely executes twice gets two different path sets.
 *
 * Deliberately the global Web Crypto rather than `node:crypto`: this module is
 * statically imported by workflow-scope block modules, and a Node builtin in
 * that import graph fails only the Vercel build, never vitest or a local one.
 */
function newLaunchId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * The wrapper one repository's setup commands and check commands run inside,
 * detached from the invocation that launched it.
 *
 * Every command still gets its own login shell. Setup commands provision the
 * toolchain the checks need, and they do it by appending a PATH export to the
 * shell profile; only a fresh login shell per later command picks that up. So
 * this must never collapse the batch into one shell body, and the wrapper
 * itself must not be that single login shell either.
 */
export function buildRepoCheckBatchScript(opts: {
  paths: RepoCheckBatchPaths;
  localPath: string;
  setup: string[];
  commands: string[];
}): string {
  const { paths, localPath, setup, commands } = opts;
  const setupLines = setup.map((command, index) =>
    [
      `run_pre_pr_command ${index} ${shellQuote(command)}`,
      // A setup failure means the toolchain is missing, so this repository's
      // checks would only report the same thing once per command. Stop here and
      // record where; the caller still runs the other repositories.
      `[ "$PRE_PR_EXIT" -eq 0 ] || stop_batch ${index}`,
    ].join("\n"),
  );
  const checkLines = commands.map(
    (command, index) =>
      `run_pre_pr_command ${setup.length + index} ${shellQuote(command)}`,
  );
  return `#!/bin/bash

# No trap here, deliberately. Bash runs a trap only when the current foreground
# command finishes (SIGNALS in bash(1)), so a handler could not fire while a
# check is running, which is the only moment it would have anything to kill;
# and \`kill 0\` signals the whole process group, which includes whatever
# launched this wrapper. Killing the launched command is stopPhaseCommand's job
# (workflows/blocks/poll-phase.ts), which kills it through the sandbox API by
# command id. What that does not reach is the command's own children: an
# abandoned check keeps running until the sandbox is torn down. That is wasted
# sandbox CPU after the run has already stopped believing the batch, not a
# correctness problem, and it is accepted rather than papered over with a
# backgrounding scheme whose failure modes would be new.

# --- Cleanup this cycle's stale files ---
rm -f ${paths.sentinel}
rm -rf ${paths.dir}
mkdir -p ${paths.dir}

# Identity first, before any command can write an output file, so the collector
# can tell this launch's files from another wrapper's.
echo ${shellQuote(paths.launchId)} > ${paths.dir}/launch

run_pre_pr_command() {
  bash -lc "$2" > ${paths.dir}/stdout-$1 2> ${paths.dir}/stderr-$1
  PRE_PR_EXIT=$?
  echo "$PRE_PR_EXIT" > ${paths.dir}/exit-$1
}

stop_batch() {
  echo "$1" > ${paths.dir}/stopped-at
  touch ${paths.sentinel}
  exit 0
}

cd ${shellQuote(localPath)} || stop_batch ${BATCH_NO_COMMAND_RAN}

${[...setupLines, ...checkLines].join("\n")}

# --- Signal completion, last, once every output file is written ---
touch ${paths.sentinel}
`;
}

/**
 * Write and launch one repository's check batch, detached, and return at once.
 *
 * Returns `skipped` when the repository is not in this run's workspace, and,
 * under `requireChange`, when its HEAD never moved: the same filter the
 * blocking runner applied before running any command.
 */
export async function startRepoCheckBatchStep(
  sandboxId: string,
  provider: WorkspaceRepo["provider"],
  repoPath: string,
  setup: string[],
  commands: string[],
  fixCycle: number,
  repoIndex: number,
  /**
   * Whether to inspect HEAD and skip a repository the agent never touched.
   * True for the configured pre-PR checks, which only verify what changed.
   * False for the explicit `commands` mode of run_checks, whose contract is to
   * run in every attached repository whether or not its HEAD moved; that mode
   * never inspected HEAD at all, so it must not start failing on a repository
   * whose git directory cannot be read.
   */
  requireChange = true,
): Promise<
  | { skipped: true }
  | {
      skipped: false;
      commandId: string;
      localPath: string;
      paths: RepoCheckBatchPaths;
    }
> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const manifest = await readWorkspaceManifest(sandbox);
  const repo = manifest.repositories.find(
    (candidate) =>
      candidate.provider === provider && candidate.repoPath === repoPath,
  );
  if (!repo) return { skipped: true };

  if (requireChange) {
    const headResult = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "rev-parse",
      "HEAD",
    ]);
    const headSha =
      headResult.exitCode === 0 ? (await headResult.stdout()).trim() : "";
    if (!headSha) {
      throw new Error(
        `Could not inspect workspace HEAD for ${provider}:${repoPath}`,
      );
    }
    if (repo.preAgentSha && repo.preAgentSha === headSha) return { skipped: true };
  }

  const paths = repoCheckBatchPaths(fixCycle, repoIndex, newLaunchId());
  await sandbox.writeFiles([
    {
      path: paths.wrapper,
      content: Buffer.from(
        buildRepoCheckBatchScript({
          paths,
          localPath: repo.localPath,
          setup,
          commands,
        }),
      ),
    },
  ]);
  const chmod = await sandbox.runCommand("chmod", ["+x", paths.wrapper]);
  if (chmod.exitCode !== 0) {
    throw new Error(
      `The Pre-PR check wrapper for ${provider}:${repoPath} could not be made executable.`,
    );
  }
  const launch = await sandbox.runCommand({
    cmd: "bash",
    args: [paths.wrapper],
    cwd: WORKSPACE_ROOT_DIR,
    detached: true,
  });
  // A detached launch has no exit code yet while the wrapper runs; only a
  // wrapper that already exited non-zero is a launch that failed.
  if (launch.exitCode !== null && launch.exitCode !== 0) {
    throw new Error(
      `The Pre-PR check batch for ${provider}:${repoPath} exited ${launch.exitCode} before it started.`,
    );
  }
  return {
    skipped: false,
    commandId: launch.cmdId,
    localPath: repo.localPath,
    paths,
  };
}
startRepoCheckBatchStep.maxRetries = 0;

/** What one collected batch got through, for reporting a stall honestly. */
export interface RepoCheckBatchProgress {
  /** Commands that recorded an exit status. */
  completed: number;
  /** Commands the batch was asked to run, setup included. */
  total: number;
  /** The command that was still running when the batch was abandoned, or null
   *  when every command recorded a status. */
  stoppedAt: string | null;
}

export interface CollectedRepoCheckBatch {
  results: PrePrCheckCommandResult[];
  failures: PrePrCheckFailure[];
  /**
   * An authored setup command failed. Suppresses fix cycles run-wide.
   *
   * A workspace directory that could not be entered is deliberately NOT one of
   * these: no setup command was authored, so nothing about it is the operator's
   * configuration and it must not silence the other repositories. Those arrive
   * as failures carrying phase "workspace", which is what callers filter on.
   */
  setupFailed: boolean;
  progress: RepoCheckBatchProgress;
}

/**
 * Read a batch's per-command files back into ordered results and failures.
 *
 * A detached command has no live stream, so every byte comes from the files the
 * wrapper wrote, and they are read whether the batch finished or was abandoned:
 * on a stall those files are the only record of which command it died on, and
 * leaving them unread reproduces the blindness this whole change exists to end.
 */
export async function collectRepoCheckBatchStep(
  sandboxId: string,
  provider: WorkspaceRepo["provider"],
  repoPath: string,
  setup: string[],
  commands: string[],
  paths: RepoCheckBatchPaths,
  localPath: string,
  /**
   * Whether the wrapper reported completion by touching its sentinel.
   *
   * True for a normal collect: every command the wrapper reached recorded an
   * exit, so a missing one means the batch was interrupted and that command
   * must not read as a pass. False when collecting an abandoned batch, where
   * the commands after the one that was still running never started at all;
   * reporting those as failures would invent results the run never produced.
   */
  batchFinished = true,
): Promise<CollectedRepoCheckBatch> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const total = setup.length + commands.length;
  const commandAt = (index: number): string =>
    index < setup.length ? setup[index]! : commands[index - setup.length]!;
  const emptyProgress: RepoCheckBatchProgress = { completed: 0, total, stoppedAt: null };
  const workspaceIncident = (reason: string): CollectedRepoCheckBatch => ({
    results: [],
    failures: [batchFailure(provider, repoPath, "(check batch)", reason, "workspace")],
    setupFailed: false,
    progress: emptyProgress,
  });

  // Ask the sandbox's status before asking it for bytes. This step is called on
  // the path where the poll just gave up, which is precisely when the sandbox
  // may be gone, and a command sent to a dead sandbox throws out of a step whose
  // maxRetries is 0. Same guard checkPhaseDone makes for the same reason
  // (sandbox/poll-agent.ts).
  if (sandbox.status !== "running") {
    return workspaceIncident(BATCH_SANDBOX_GONE_REASON);
  }

  const read = await readBatchFiles(sandbox, paths, total);
  // "The reader failed" and "the marker disagrees" are different diagnoses and
  // must never be reported as each other. The reader runs under `bash -lc`,
  // which sources the very profile these setup commands append to, so a broken
  // profile fails the read while the batch itself is fine.
  if (!read.ok) return workspaceIncident(BATCH_READER_FAILED_REASON);
  const files = read.files;
  // Zero records is the reader losing its own stdout, not a batch that never
  // started. `names` always asks for `launch` and `stopped-at`, and the script
  // emits one record per name whether or not the file exists, so a successful
  // reader cannot return nothing. A login profile that redirects the shell's
  // stdout (`exec 1>/dev/null`) produces exactly this, and reporting it as
  // "the wrapper never started" sends the operator to look at the wrapper.
  if (files.size === 0) return workspaceIncident(BATCH_READER_FAILED_REASON);

  // Identity before content. A directory whose `launch` marker is not this
  // launch's was written by a different wrapper, so nothing in it describes the
  // batch being collected and none of it may become a pass. Belt and braces
  // rather than the primary guarantee: the launch id is already part of the
  // directory, the wrapper path and the sentinel, so two launches cannot share
  // a path set at all.
  const launch = files.get("launch");
  if (!launch || launch.bytes <= 0) {
    // The wrapper writes this marker before anything else it does, so its
    // absence means the wrapper never ran, which is worth saying plainly
    // instead of arriving later as "the first command recorded no exit".
    return workspaceIncident(BATCH_NEVER_STARTED_REASON);
  }
  if (decodeBatchFile(launch) !== paths.launchId) {
    return workspaceIncident(BATCH_IDENTITY_REASON);
  }

  const stoppedAtFile = files.get("stopped-at");
  const stoppedAtText = stoppedAtFile ? decodeBatchFile(stoppedAtFile) : "";
  const stoppedAt = /^-?\d+$/.test(stoppedAtText) ? Number(stoppedAtText) : null;
  if (stoppedAt === BATCH_NO_COMMAND_RAN) {
    return {
      results: [],
      failures: [
        batchFailure(
          provider,
          repoPath,
          "(repository workspace)",
          `${BATCH_WORKSPACE_MISSING_REASON} Directory: ${localPath}.`,
          "workspace",
        ),
      ],
      setupFailed: false,
      progress: emptyProgress,
    };
  }

  // `stopped-at` is the authority on how far a finished wrapper got: absent
  // means every command ran, an index means only the commands up to and
  // including it did. An abandoned batch wrote no marker, so its boundary is
  // the first command with no recorded exit.
  const lastIndex = stoppedAt === null ? total - 1 : stoppedAt;
  const results: PrePrCheckCommandResult[] = [];
  const failures: PrePrCheckFailure[] = [];
  let setupFailed = false;
  let completed = 0;
  let stoppedAtCommand: string | null = null;

  for (let index = 0; index <= lastIndex; index++) {
    const isSetup = index < setup.length;
    const command = commandAt(index);
    const exitFile = files.get(`exit-${index}`);
    const exitText = exitFile ? decodeBatchFile(exitFile) : "";
    const exitCode = /^-?\d+$/.test(exitText) ? Number(exitText) : null;

    if (exitCode === null) {
      if (!batchFinished) {
        // The batch was abandoned here. This command was still running and the
        // ones after it never started, so neither is a result of any kind.
        stoppedAtCommand = command;
        break;
      }
      // The wrapper said it reached this command and then recorded no status,
      // so the batch was interrupted between the two. Never a pass.
      failures.push({
        provider,
        repoPath,
        command,
        exitCode: -1,
        stdout: streamText(files.get(`stdout-${index}`)),
        stderr: streamText(files.get(`stderr-${index}`)),
        note: BATCH_MISSING_EXIT_REASON,
        ...(isSetup ? { phase: "setup" as const } : {}),
      });
      if (isSetup) setupFailed = true;
      continue;
    }

    completed++;
    const stdout = streamText(files.get(`stdout-${index}`));
    const stderr = streamText(files.get(`stderr-${index}`));

    if (isSetup) {
      if (exitCode !== 0) {
        setupFailed = true;
        failures.push({ provider, repoPath, command, exitCode, stdout, stderr, phase: "setup" });
      }
      continue;
    }

    results.push({ provider, repoPath, command, exitCode });
    // A configured check that exits 0 while reporting that it never ran (its
    // dependencies are not installed) must fail loudly instead of being trusted
    // as a pass. The Run Workspace is never dependency-installed, so a check
    // tool that self-skips on missing deps with a success exit code once let a
    // blocked check clear the pre-PR gate: the branch was pushed and the PR's
    // own CI then caught the lint failure the gate exists to prevent.
    //
    // The flag comes from the reader, which greps the whole file: scanning the
    // text carried back here would miss a phrase straddling the truncation cut,
    // which is exactly the false pass this catches. Two independent signals are
    // required before a zero exit is called a failure, so a green suite that
    // merely mentions one of the phrases stays green
    // (MISSING_DEPENDENCY_ABSENCE_PHRASES).
    const blockedByMissingDependencies =
      exitCode === 0 &&
      Boolean(files.get(`stdout-${index}`)?.blocked || files.get(`stderr-${index}`)?.blocked);
    if (exitCode !== 0 || blockedByMissingDependencies) {
      failures.push({
        provider,
        repoPath,
        command,
        exitCode,
        stdout,
        stderr,
        ...(blockedByMissingDependencies ? { note: MISSING_DEPENDENCY_FAILURE_REASON } : {}),
      });
    }
  }

  return {
    results,
    failures: finalizeBatchFailures(failures),
    setupFailed,
    progress: { completed, total, stoppedAt: stoppedAtCommand },
  };
}
collectRepoCheckBatchStep.maxRetries = 0;

/**
 * Bound what one collect returns in total.
 *
 * Every failure gets the same share, so the entry an operator reads first is
 * not the most truncated: a share that grows as the budget is spent gave the
 * first failure 1024 characters and the sixteenth 4153. The share is at least
 * BATCH_FAILURE_FLOOR_CHARS, because a repository with three verbose failing
 * checks would otherwise spend everything on the first two and hand back the
 * third empty, and the third is as likely as either to be the one being read.
 *
 * A share is split across a failure's two streams by what they actually hold,
 * not 50/50: half of a fixed split is wasted whenever the output is on one
 * stream, which for a check tool is the common case.
 *
 * The budget is then a hard stop, not a target. Nothing bounds how many
 * commands a repository may configure, and this return value is persisted in
 * the run's event log, in a repository that has lost runs to
 * CORRUPTED_EVENT_LOG. What does not fit is reported as an entry of its own:
 * an omitted failure that says nothing is a silent truncation, which is the
 * failure mode this whole change exists to end.
 */
function finalizeBatchFailures(failures: PrePrCheckFailure[]): PrePrCheckFailure[] {
  const share = Math.max(
    BATCH_FAILURE_FLOOR_CHARS,
    Math.floor(BATCH_COLLECT_MAX_CHARS / Math.max(1, failures.length)),
  );
  const bounded: PrePrCheckFailure[] = [];
  let used = 0;

  for (const [index, failure] of failures.entries()) {
    if (used >= BATCH_COLLECT_MAX_CHARS) {
      const omitted = failures.length - index;
      bounded.push({
        provider: failure.provider,
        repoPath: failure.repoPath,
        command: `(${omitted} further failing command${omitted === 1 ? "" : "s"})`,
        exitCode: -1,
        stdout: "",
        stderr: "",
        note: `${omitted} further failing command${omitted === 1 ? "" : "s"} of this repository are not listed: the collected output reached ${BATCH_COLLECT_MAX_CHARS} characters, which is all one step return value may carry into the run's event log. Re-run the checks after fixing the ones above.`,
        phase: "omitted",
      });
      break;
    }
    const [stderrShare, stdoutShare] = splitStreamShare(
      share,
      failure.stderr.length,
      failure.stdout.length,
    );
    const stderr = boundFailureOutput(failure.stderr, stderrShare);
    const stdout = boundFailureOutput(failure.stdout, stdoutShare);
    used += stderr.length + stdout.length;
    bounded.push({ ...failure, stdout, stderr });
  }
  return bounded;
}

/**
 * Divide one failure's share between its two streams by what each holds.
 *
 * A stream shorter than its half keeps everything and hands the rest to the
 * other, so a failure whose output is entirely on stderr keeps the whole share
 * of it rather than half. Both streams fitting means neither is cut at all.
 */
function splitStreamShare(
  share: number,
  stderrLength: number,
  stdoutLength: number,
): [number, number] {
  if (stderrLength + stdoutLength <= share) return [stderrLength, stdoutLength];
  const half = Math.floor(share / 2);
  const stderrShare = Math.min(stderrLength, half);
  const stdoutShare = Math.min(stdoutLength, share - stderrShare);
  return [share - stdoutShare, stdoutShare];
}

/** One file as the batch reader emitted it. `bytes` is -1 for a file that does
 *  not exist, which is how "this command never ran" arrives. */
interface BatchFileRead {
  bytes: number;
  head: string;
  tail: string | null;
  /** The reader found both missing-dependency signals anywhere in the whole
   *  file, before any truncation. */
  blocked: boolean;
}

/**
 * Marker every reader record starts with.
 *
 * The reader runs under `bash -lc`, which sources the shell profile these
 * setup commands append to, so anything that profile prints lands on the same
 * stdout. Without a token to match, a profile that prints without a trailing
 * newline glues its text onto the first record, `parts[0]` stops being a file
 * name, and a batch that ran to completion is diagnosed as a wrapper that never
 * started: confident, wrong, and impossible for the operator to falsify.
 * Unrecognised lines are skipped instead.
 */
const BATCH_READ_MARKER = "PREPRCHK";

/**
 * The shell the reader runs. Pure and exported so it can be executed under a
 * real bash in the tests: it is load-bearing, and a JavaScript reimplementation
 * of it in a fake proves only that the fake agrees with itself.
 */
export function buildBatchReaderScript(opts: { dir: string; names: string[] }): string {
  const cap = BATCH_STREAM_HEAD_BYTES + BATCH_STREAM_TAIL_BYTES;
  const anyOf = (phrases: string[]): string =>
    `grep -qiF ${phrases.map((phrase) => `-e ${shellQuote(phrase)}`).join(" ")} -- "$2"`;
  return [
    "emit() {",
    `  if [ ! -f "$2" ]; then printf '${BATCH_READ_MARKER} %s -1 0 - -\n' "$1"; return; fi`,
    '  b=$(wc -c < "$2" | tr -d " \t")',
    // Two signals, both required. See MISSING_DEPENDENCY_ABSENCE_PHRASES.
    `  if ${anyOf(MISSING_DEPENDENCY_ABSENCE_PHRASES)} && ${anyOf(
      MISSING_DEPENDENCY_INSTALL_PHRASES,
    )}; then k=1; else k=0; fi`,
    `  if [ "$b" -le ${cap} ]; then`,
    '    h=$(base64 < "$2" | tr -d "\n"); t=-',
    "  else",
    `    h=$(head -c ${BATCH_STREAM_HEAD_BYTES} "$2" | base64 | tr -d "\n")`,
    `    t=$(tail -c ${BATCH_STREAM_TAIL_BYTES} "$2" | base64 | tr -d "\n")`,
    "  fi",
    '  [ -z "$h" ] && h=-',
    '  [ -z "$t" ] && t=-',
    `  printf '${BATCH_READ_MARKER} %s %s %s %s %s\n' "$1" "$b" "$k" "$h" "$t"`,
    "}",
    // Terminate whatever the profile printed before the first record starts.
    // The marker lets the parser skip a profile's line; it cannot rescue a
    // record the profile glued itself onto, and in production the first record
    // is the launch marker, whose loss is diagnosed as "the wrapper never
    // started". One newline costs nothing and removes the case.
    "printf '\\n'",
    ...opts.names.map(
      (name) => `emit ${shellQuote(name)} ${shellQuote(`${opts.dir}/${name}`)}`,
    ),
  ].join("\n");
}

/** Parse one reader record. Anything that is not a record is not a file: the
 *  shell profile shares this stdout. */
export function parseBatchReaderOutput(stdout: string): Map<string, BatchFileRead> {
  const files = new Map<string, BatchFileRead>();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(" ");
    if (parts.length !== 6 || parts[0] !== BATCH_READ_MARKER) continue;
    const [, name, bytesText, blocked, head, tail] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^-?\d+$/.test(bytesText)) continue;
    files.set(name, {
      bytes: Number(bytesText),
      head: head === "-" ? "" : head,
      tail: tail === "-" ? null : tail,
      blocked: blocked === "1",
    });
  }
  return files;
}

/**
 * Read every file of one batch in a single sandbox round trip.
 *
 * Three reads per command times twenty commands is sixty sequential round trips
 * inside one step whose maxRetries is 0, which is the same unbounded-await
 * shape this change exists to remove, only with a friendlier constant. One
 * command returns the lot.
 *
 * The payloads are base64 so the line format cannot be broken by the content:
 * base64's alphabet contains neither a space nor a newline, so splitting on
 * them is exact rather than a guess. That is the one delimiter this path is
 * willing to parse.
 *
 * The reader also answers the one question truncation would otherwise destroy:
 * whether the tool reported that it could not run. It greps the whole file, so
 * a phrase straddling the cut is still found, and `ok` separates a reader that
 * failed from a batch that produced nothing.
 */
async function readBatchFiles(
  sandbox: SandboxSession,
  paths: RepoCheckBatchPaths,
  total: number,
): Promise<{ ok: boolean; files: Map<string, BatchFileRead> }> {
  const names = ["launch", "stopped-at"];
  for (let index = 0; index < total; index++) {
    names.push(`exit-${index}`, `stdout-${index}`, `stderr-${index}`);
  }
  const script = buildBatchReaderScript({ dir: paths.dir, names });
  const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script] });
  if (result.exitCode !== 0) return { ok: false, files: new Map() };
  return { ok: true, files: parseBatchReaderOutput(await result.stdout()) };
}

/** Decode one read back to text, splicing in what the reader left out. */
function decodeBatchFile(file: BatchFileRead): string {
  if (file.bytes < 0) return "";
  const head = Buffer.from(file.head, "base64").toString("utf8");
  if (file.tail === null) return head.trim();
  const omitted = file.bytes - BATCH_STREAM_HEAD_BYTES - BATCH_STREAM_TAIL_BYTES;
  const tail = Buffer.from(file.tail, "base64").toString("utf8");
  return `${head.trimStart()}\n[... ${omitted} bytes of this command's output omitted ...]\n${tail.trimEnd()}`;
}

function streamText(file: BatchFileRead | undefined): string {
  return file ? decodeBatchFile(file) : "";
}

function batchFailure(
  provider: WorkspaceRepo["provider"],
  repoPath: string,
  command: string,
  reason: string,
  phase: PrePrCheckFailure["phase"],
): PrePrCheckFailure {
  return {
    provider,
    repoPath,
    command,
    exitCode: -1,
    stdout: "",
    stderr: reason,
    ...(phase ? { phase } : {}),
  };
}

/**
 * Every repository attached to this run's workspace, in manifest order.
 *
 * The configured pre-PR checks walk their own configuration and let the start
 * step resolve each entry, but the explicit `commands` mode of run_checks runs
 * in every attached repository, so its walk needs the manifest before it can
 * start anything.
 */
export async function listWorkspaceRepositoriesStep(
  sandboxId: string,
): Promise<Array<{ provider: WorkspaceRepo["provider"]; repoPath: string }>> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const manifest = await readWorkspaceManifest(sandbox);
  return manifest.repositories.map((repo) => ({
    provider: repo.provider,
    repoPath: repo.repoPath,
  }));
}
listWorkspaceRepositoriesStep.maxRetries = 0;

async function readWorkspaceManifest(sandbox: SandboxSession): Promise<WorkspaceManifest> {
  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  if (manifestResult.exitCode !== 0) {
    throw new Error(`Workspace manifest not found in sandbox at ${WORKSPACE_MANIFEST_PATH}`);
  }
  return parseWorkspaceManifest(await manifestResult.stdout());
}

/**
 * Materialize the pinned harness, write the repair prompt and wrapper, and
 * launch the repair agent detached. Completion is read from the wrapper's
 * sentinel by the caller's poll, never by holding this invocation open.
 */
export async function startPrePrRepairStep(
  sandboxId: string,
  agentKind: "claude" | "codex",
  model: string,
  fixCycle: number,
  failureSummary: string,
  runtime?: ResolvedHarnessRuntime,
  arthurTaskId?: string | null,
): Promise<
  | { ok: true; commandId: string; phase: string; paths: PhaseArtifactPaths }
  | {
      ok: false;
      failure: Extract<AgentProtocolResult<unknown>, { ok: false }>;
    }
> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const effectiveAgentKind =
    runtime?.manifest.schemaVersion === 2
      ? runtime.manifest.harness.provider
      : agentKind;
  const adapter = createAgentAdapter(effectiveAgentKind, runtime?.cliSpec);
  if (runtime) {
    const { env } = await import("../../env.js");
    const { getDb } = await import("../db/client.js");
    const { dashboardOrganizationId } = await import(
      "../workflow-definition/harness-profile-runtime.js"
    );
    const { resolveHarnessProfileVersion } = await import(
      "../harness-profiles/store.js"
    );
    const {
      materializePinnedHarnessFiles,
      resetHarnessRuntimeHomes,
      resolveRuntimeCredentials,
    } = await import("../sandbox/harness-runtime.js");
    await resetHarnessRuntimeHomes(sandbox);
    const organizationId = await dashboardOrganizationId(
      getDb(),
      env.DASHBOARD_ORG_SLUG,
    );
    const resolved = await resolveHarnessProfileVersion(getDb(), {
      organizationId,
      profileId: runtime.manifest.profileId,
      version: runtime.manifest.version,
    });
    if (!resolved || resolved.manifestHash !== runtime.manifestHash) {
      throw new Error(
        "The pinned Harness Profile changed or became unavailable before Pre-PR repair.",
      );
    }
    await materializePinnedHarnessFiles(
      sandbox,
      runtime,
      resolved.skillArtifacts,
    );
    await adapter.install(sandbox, runtime.paths);
    const arthur =
      env.GENAI_ENGINE_API_KEY &&
      env.GENAI_ENGINE_TRACE_ENDPOINT &&
      arthurTaskId
        ? {
            apiKey: env.GENAI_ENGINE_API_KEY,
            taskId: arthurTaskId,
            endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
          }
        : undefined;
    const effectiveModel =
      runtime.manifest.schemaVersion === 2
        ? runtime.manifest.model.id
        : model;
    await adapter.configure(sandbox, {
      ...resolveRuntimeCredentials(runtime.manifest, {
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        codexApiKey: env.CODEX_API_KEY,
        codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
      }),
      model: effectiveModel,
      arthur,
      runtime: runtime.paths,
      ...(runtime.modelSettings
        ? { modelSettings: runtime.modelSettings }
        : {}),
      legacyDynamicSkills: false,
    });
  }
  await adapter.setCommitGuard(sandbox, true, runtime?.paths);
  const phase = `pre-pr-fix-${fixCycle}`;
  const paths = adapter.artifactPaths(phase);
  const effectiveModel =
    runtime?.manifest.schemaVersion === 2
      ? runtime.manifest.model.id
      : model;
  const script = adapter.buildPhaseScript({
    phase,
    model: effectiveModel,
    paths,
    ...(runtime
      ? {
          runtime: runtime.paths,
          ...(runtime.modelSettings
            ? { modelSettings: runtime.modelSettings }
            : {}),
        }
      : {}),
  });
  await sandbox.writeFiles([
    {
      path: paths.input,
      content: Buffer.from(buildFixPrompt(failureSummary)),
    },
    { path: paths.wrapper, content: Buffer.from(script) },
  ]);
  const chmod = await sandbox.runCommand("chmod", ["+x", paths.wrapper]);
  if (chmod.exitCode !== 0) {
    const { protocolFailure } = await import("../sandbox/agents/protocol.js");
    const artifacts = await collectPhaseFromSandbox(sandbox, paths);
    const failure = protocolFailure({
      spec: adapter.cliSpec,
      phase,
      artifacts,
      failureKind: "setup_failed",
      category: "provider",
      message: "The current agent phase could not be completed.",
      detail: "The Pre-PR repair wrapper could not be made executable.",
    });
    if (failure.ok) throw new Error("unreachable");
    return { ok: false, failure };
  }
  let launch: SandboxCommand;
  try {
    // Detached, like every other agent phase (see writeAndStartPhase in
    // workflows/agent.ts): the sandbox SDK keeps one ndjson stream open for the
    // whole of a blocking runCommand, and a repair agent outlives the function
    // invocation that started it. When that invocation ends mid-stream the SDK
    // raises a parse/stream error rather than an abort, which reached the
    // generic catch below and reported a launch failure with no exit code and
    // no bytes for an agent that was in fact running. A detached launch returns
    // at once and completion is read from the wrapper's sentinel file instead.
    launch = await sandbox.runCommand({
      cmd: "bash",
      args: [paths.wrapper],
      cwd: WORKSPACE_ROOT_DIR,
      detached: true,
    });
  } catch (error) {
    const { protocolFailure, redactDiagnosticText } = await import(
      "../sandbox/agents/protocol.js"
    );
    const { logger } = await import("../lib/logger.js");
    // The thrown error used to be discarded here, so a launch that never
    // produced a process left no exit code, no bytes and no cause: the only
    // reachable text named the boundary. Carry the reason, redacted and bounded
    // exactly like a diagnostic tail so a runaway error text cannot become the
    // run status. The kind is `setup_failed`, not `provider_error`: nothing was
    // sent to a provider, this is the same "the phase never started" family as
    // the chmod failure above, and calling it a provider error is what made
    // every occurrence read as spent provider credits.
    const code = (error as { code?: unknown }).code;
    const label =
      typeof code === "string" && code
        ? code
        : error instanceof Error
          ? error.name
          : "";
    const message = error instanceof Error ? error.message : String(error);
    const cause = redactDiagnosticText(
      label && label !== "Error" ? `${label}: ${message}` : message,
    ).slice(0, PRE_PR_LAUNCH_CAUSE_MAX_LENGTH);
    logger.error({ phase, cause }, "pre_pr_repair_launch_failed");
    const failure = protocolFailure({
      spec: adapter.cliSpec,
      phase,
      artifacts: { stdout: "", stderr: "", structuredOutput: null, exitCode: null },
      failureKind: "setup_failed",
      category: "provider",
      message: "The current agent phase could not be completed.",
      detail: `The Pre-PR repair process could not be launched: ${cause}`,
    });
    if (failure.ok) throw new Error("unreachable");
    return { ok: false, failure };
  }
  // A detached launch has no exit code yet while the wrapper runs; only a
  // wrapper that already exited non-zero is a launch that failed.
  if (launch.exitCode !== null && launch.exitCode !== 0) {
    const { commandProtocolFailure } = await import("../sandbox/agents/protocol.js");
    return {
      ok: false,
      failure: await commandProtocolFailure({
        spec: adapter.cliSpec,
        phase,
        result: launch,
        failureKind: "cli_exit",
        message: "The current agent phase could not be completed.",
        detail: "The Pre-PR repair process could not be launched.",
      }),
    };
  }
  return { ok: true, commandId: launch.cmdId, phase, paths };
}
startPrePrRepairStep.maxRetries = 0;

/** Why a polled repair phase produced no sentinel. `none` means it finished. */
export type PrePrPhaseStall = "none" | "timed_out" | "sandbox_stopped";

/**
 * Read a finished repair phase's artifacts, or turn a stalled poll into an
 * agent failure. The two stalls stay distinguishable: a phase that outlived its
 * cap and a sandbox that died under it are different operational faults.
 */
export async function collectPrePrRepairStep(
  sandboxId: string,
  agentKind: "claude" | "codex",
  phase: string,
  paths: PhaseArtifactPaths,
  stall: PrePrPhaseStall,
  /** Tick time the repair poll consumed. Reported instead of the constant: the
   *  cap that applies is the smaller of PRE_PR_REPAIR_MAX_MINUTES and what the
   *  run's remaining duration budget allows, so naming the constant tells an
   *  operator the agent got 25 minutes when it may have had eight. */
  elapsedMs: number,
  runtime?: ResolvedHarnessRuntime,
): Promise<{
  usage: PhaseUsage | null;
  failure?: Extract<AgentProtocolResult<unknown>, { ok: false }>;
}> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const effectiveAgentKind =
    runtime?.manifest.schemaVersion === 2
      ? runtime.manifest.harness.provider
      : agentKind;
  const adapter = createAgentAdapter(effectiveAgentKind, runtime?.cliSpec);
  if (stall !== "none") {
    const { protocolFailure } = await import("../sandbox/agents/protocol.js");
    const failure = protocolFailure({
      spec: adapter.cliSpec,
      phase,
      artifacts: { stdout: "", stderr: "", structuredOutput: null, exitCode: null },
      failureKind: "provider_error",
      category: "provider",
      message: "The current agent phase could not be completed.",
      detail:
        stall === "sandbox_stopped"
          ? "The sandbox stopped before the Pre-PR repair process finished."
          : `The Pre-PR repair process ran for ${formatElapsed(elapsedMs)} without finishing and was stopped.`,
    });
    if (failure.ok) throw new Error("unreachable");
    return { usage: null, failure };
  }
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const artifacts = await collectPhaseFromSandbox(sandbox, paths);
  const usage = adapter.extractUsage(artifacts.stdout, artifacts.structuredOutput);
  const protocol = adapter.validateFreeformProtocol(artifacts, phase);
  return protocol.ok ? { usage } : { usage, failure: protocol };
}
collectPrePrRepairStep.maxRetries = 0;

async function collectPhaseFromSandbox(
  sandbox: SandboxSession,
  paths: PhaseArtifactPaths,
): Promise<CollectedPhaseArtifacts> {
  const read = async (path: string): Promise<string> => {
    const result = await sandbox.runCommand("cat", [path]);
    return result.exitCode === 0 ? (await result.stdout()).trim() : "";
  };
  const stdout = await read(paths.stdout);
  const stderr = await read(paths.stderr);
  const structuredOutput = paths.structuredOutput
    ? (await read(paths.structuredOutput)) || null
    : null;
  const exitCodeText = await read(paths.exitCode);
  return {
    stdout,
    stderr,
    structuredOutput,
    exitCode: /^-?\d+$/.test(exitCodeText) ? Number(exitCodeText) : null,
  };
}

function buildFixPrompt(failureSummary: string): string {
  return `Pre-PR checks failed for the Run Workspace.

Fix the issues, commit your fixes, and do not push or create pull requests.

${failureSummary}`;
}

export function formatPrePrCheckFailures(
  failures: PrePrCheckFailure[],
  /**
   * Repositories whose setup failed, if any. Setup failure suppresses fix
   * cycles for the WHOLE run, so without this an unrelated repository's entry
   * shows a plainly repairable failure next to fixCycles: 0 and says nothing
   * about why nothing was attempted. Naming the blast radius where the reader
   * is already looking is the same job WORKSPACE_FAILURE_REASON does for the
   * opposite case.
   */
  suppressingRepositories: string[] = [],
  /** Fix cycles this run had already spent when these failures were collected.
   *  Suppression is evaluated per pass, so the sentence must speak for the
   *  cycles that remain, not claim the fixer never ran. */
  fixCyclesRun = 0,
): string {
  const suppressed = suppressingRepositories.length > 0;
  return failures
    .map((failure) => {
      const repoKey = `${failure.provider}:${failure.repoPath}`;
      const output = boundFailureOutput(
        [failure.stderr, failure.stdout]
          .map((part) => part.trim())
          .filter(Boolean)
          .join("\n"),
      );
      return [
        failure.phase === "setup"
          ? `SETUP FAILED for ${repoKey}`
          : failure.phase === "workspace"
            ? `WORKSPACE UNAVAILABLE for ${repoKey}`
            : failure.phase === "batch"
              ? `CHECK BATCH ABANDONED for ${repoKey}`
              : failure.phase === "omitted"
                ? `FAILURES OMITTED for ${repoKey}`
                : repoKey,
        `Command: ${failure.command}`,
        `Exit code: ${failure.exitCode}`,
        output ? `Output:\n${output}` : "Output: (empty)",
        // After the output and outside the bound: the note explains the entry
        // and must survive whatever truncation the output took.
        ...(failure.note ? [failure.note] : []),
        ...(failure.phase === "setup" ? [SETUP_FAILURE_REASON] : []),
        ...(failure.phase === "workspace" ? [WORKSPACE_FAILURE_REASON] : []),
        ...(suppressed && failure.phase === undefined
          ? [suppressedBySetupFailure(suppressingRepositories, fixCyclesRun)]
          : []),
      ].join("\n");
    })
    .join("\n\n");
}

function suppressedBySetupFailure(repositories: string[], fixCyclesRun: number): string {
  const opening =
    fixCyclesRun === 0
      ? "No agent fix cycles were run for this failure either."
      : `No further agent fix cycles were run for this failure (${fixCyclesRun} had already run).`;
  return (
    `${opening} Setup failed for ${repositories.join(", ")}, and a setup failure ` +
    "suppresses the fix cycles of the whole run, because a fixer cannot install " +
    "a toolchain by editing code. Fix that setup command and this check gets " +
    "its fix cycles back."
  );
}

const SETUP_FAILURE_REASON =
  "This is a setup command, not a check: it runs once before this repository's " +
  "checks to provision its toolchain. The repository's checks were skipped and " +
  "no agent fix cycles were run, because editing the code cannot repair a " +
  "workspace that could not be provisioned. Fix the setup command in the " +
  "dashboard's Pre-PR checks configuration.";

/**
 * How much of a failure's output a reader actually receives.
 *
 * Deliberately far below the stream bytes above, and measuring a different
 * thing: that bound is what may enter the event log, this is what fits in a
 * fix prompt and a run summary next to everything else a failure carries. The
 * two must not be collapsed into one number, and a head slice of a
 * tail-truncated stream is the specific mistake to avoid: on a long log it
 * lands in the middle, showing neither the first error nor the summary.
 */
export const FAILURE_OUTPUT_MAX_CHARS = 2_000;

/**
 * Keep both ends of a failure's output within `maxChars`.
 *
 * Half from each end, so `tsc` and `mypy` (root cause first) and `pytest`
 * (verdict last) both survive the same bound.
 */
export function boundFailureOutput(text: string, maxChars = FAILURE_OUTPUT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  const marker = `\n[... ${omitted} characters omitted ...]\n`;
  const budget = maxChars - marker.length;
  // Nothing sensible to split when the bound cannot even hold the marker.
  if (budget <= 0) return text.slice(0, maxChars);
  const head = Math.ceil(budget / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (budget - head))}`;
}

/**
 * How much of each end of a per-command stream the collector carries out of the
 * sandbox.
 *
 * Sized against what a consumer actually shows, not against what the event log
 * will tolerate: every path that displays one of these streams bounds it to
 * FAILURE_OUTPUT_MAX_CHARS (2000) first, so bytes far beyond that are carried
 * across a step boundary, persisted in the run's event log, and then thrown
 * away unread. Anyone tempted to raise this should raise the consumer bound
 * instead, and check what it costs in the log.
 *
 * Both ends, never just one. A compiler puts the root cause first and a test
 * runner puts the verdict last. Which end a phrase lands in no longer decides
 * anything, though: the missing-dependency question is answered by the reader,
 * which greps the whole file.
 */
const BATCH_STREAM_HEAD_BYTES = 2 * 1024;
const BATCH_STREAM_TAIL_BYTES = 2 * 1024;

/**
 * Target for the text one collect returns in total, and the floor no single
 * failure drops below.
 *
 * The per-stream bound above is per file; a repository with a dozen verbose
 * failing commands multiplies it, and all of it is persisted in the run's
 * event log as a step return value, in a repository that has lost runs to
 * CORRUPTED_EVENT_LOG. The floor is what stops that accounting from erasing
 * the last failure of three, and it is the consumer bound, so a failure at the
 * floor still shows an operator everything they would have been shown anyway.
 */
const BATCH_COLLECT_MAX_CHARS = 32 * 1024;
/**
 * The floor is the consumer bound, and the two halves of a failure (stdout and
 * stderr) split it. A failure held at the floor therefore still carries
 * everything a consumer would have shown: those consumers bound the JOIN of the
 * two streams to FAILURE_OUTPUT_MAX_CHARS. Nothing is lost by being last.
 */
const BATCH_FAILURE_FLOOR_CHARS = FAILURE_OUTPUT_MAX_CHARS;

/** Elapsed wall clock, for a message an operator reads. Rounded, because the
 *  precision is not the point and a false precision invites arithmetic. */
export function formatElapsed(ms: number): string {
  if (ms < 90_000) {
    const seconds = Math.round(ms / 1_000);
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const BATCH_WORKSPACE_MISSING_REASON =
  "The repository's workspace directory could not be entered, so not one of its " +
  "commands ran.";

const BATCH_IDENTITY_REASON =
  "This repository's check output does not belong to the batch that was " +
  "launched for it, so none of it describes this run. Nothing was verified.";

const BATCH_NEVER_STARTED_REASON =
  "This repository's check batch left no trace at all: the wrapper writes its " +
  "own marker before it runs anything, and that marker is absent, so the batch " +
  "never started. Nothing was verified.";

const BATCH_READER_FAILED_REASON =
  "This repository's check output could not be read back out of the Run " +
  "Workspace, so what the checks did is unknown. The commands may well have " +
  "run; nothing about their result can be claimed either way.";

const BATCH_SANDBOX_GONE_REASON =
  "The Run Workspace sandbox was no longer running when this repository's check " +
  "output was collected, so nothing could be read back. Nothing was verified.";

const WORKSPACE_FAILURE_REASON =
  "This is the run's own workspace failing, not a command anyone configured. " +
  "No setup or check command of this repository is at fault and none needs " +
  "editing; the other repositories are unaffected and their fix cycles still run.";

const BATCH_MISSING_EXIT_REASON =
  "This command's exit status was never recorded, so the pre-PR check batch was " +
  "interrupted while it ran. The command is reported as failed rather than passed.";

const MISSING_DEPENDENCY_FAILURE_REASON =
  "Pre-PR check exited 0 but its dependencies are not installed, so the check did not actually run.";

/**
 * Two independent signals a check tool prints when it exits 0 without running,
 * because the project's dependencies are not installed. The reader fails such a
 * check only when BOTH appear: a statement that the dependencies are absent,
 * AND an instruction to run an installer.
 *
 * One signal is not enough, and this repository is the proof: its own test
 * titles contain "dependencies are not installed", so a green suite printing a
 * verbose test list would be reported as a blocked check. Requiring the
 * installer instruction as well keeps that suite passing while still failing
 * the real message, because a tool telling you it did nothing always tells you
 * what to run: `yarn install`, `npm install`, `npm ci`, `pnpm install`,
 * `bun install`. Verified both ways by executing the reader against captured
 * output (see runner.test.ts, "the batch reader shell").
 *
 * Matched by `grep -iF`, so these are literal, case-insensitive substrings: no
 * regular expression metacharacters, and no dependence on how a tool decorates
 * the command it names (backticks, quotes, indentation).
 *
 * Residual risk, deliberately accepted: a suite that exits 0 while printing
 * both signals, for instance a skipped test whose title names an installer,
 * still reads as blocked. The next lever would be requiring both on one line,
 * which yarn's and npm's real one-line messages satisfy; it is not taken yet
 * because nothing has produced that false positive.
 */
const MISSING_DEPENDENCY_ABSENCE_PHRASES = [
  "dependencies are not installed",
  "dependencies must be installed",
  "dependencies were not installed",
];

const MISSING_DEPENDENCY_INSTALL_PHRASES = [
  "yarn install",
  "npm install",
  "npm ci",
  "pnpm install",
  "bun install",
];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
