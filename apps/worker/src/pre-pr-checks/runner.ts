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
  PhaseUsage,
  RunnableSandbox,
} from "../sandbox/agents/types.js";
import type { TokenPrice } from "../sandbox/agents/pricing.js";
import type {
  RunBudgetFailure,
  RunBudgetLimits,
  RunBudgetState,
} from "../workflows/run-budget.js";

/**
 * Repair cycles a repository script batch runs: none, and no machinery is left
 * to run them.
 *
 * Every cycle re-ran a tenant's entire batch, so three cycles of an 810s batch
 * burned 54 minutes of a 100 minute run budget, and the loop could not tell a
 * broken environment from broken code. Worse, the loop hid failing checks: six
 * runs differing only in maxFixCycles showed that a green batch was often green
 * because the fixer had already patched over what the checks caught. Remediation
 * belongs after the pull request is open, where provider CI has reported what
 * failed.
 *
 * @deprecated Kept as a constant zero because the graph schema and the flow
 * editor still carry a maxFixCycles param. Stage 3 removes the param, and this
 * with it.
 */
export const MAX_PRE_PR_FIX_CYCLES = 0;

/**
 * Per-command wall clock bound, in minutes, when neither the repository's own
 * `commandTimeoutMinutes` nor PRE_PR_COMMAND_TIMEOUT_MINUTES says otherwise.
 *
 * A bound on the COMMAND, distinct from the bound on the batch. Before this,
 * one hung command consumed the whole batch cap and the run reported an
 * abandoned batch, which names neither the command that hung nor the ones that
 * never got to run. Ten minutes is above every real check we have measured
 * (a client tenant's slowest suite is roughly six) and far below the batch cap.
 */
export const DEFAULT_COMMAND_TIMEOUT_MINUTES = 10;

/** Grace `timeout` leaves between SIGTERM and SIGKILL. Long enough for a test
 *  runner to flush its output file, short enough not to matter to the batch. */
const COMMAND_TIMEOUT_KILL_GRACE_SECONDS = 5;

/** What GNU coreutils `timeout` exits with when it killed the command. Any
 *  other non-zero exit is the command's own verdict, and 124 is a code a
 *  command is perfectly free to return on its own, which is why the collector
 *  corroborates it with the measured duration. */
const COMMAND_TIMEOUT_EXIT_CODE = 124;

/**
 * How close to its bound a command must have run before its exit 124 is
 * believed to be the timeout rather than the command's own exit code.
 *
 * Not 1.0: the clock is read after `timeout` has signalled and the process has
 * been reaped, and a runner given up to COMMAND_TIMEOUT_KILL_GRACE_SECONDS to
 * flush can also land marginally under the bound depending on where the reading
 * falls. A tenth of the bound absorbs both without letting a command that
 * exited 124 in four seconds claim it ran out of ten minutes.
 */
const COMMAND_TIMEOUT_DURATION_RATIO = 0.9;

/**
 * Operator allowlist for environment forwarding, comma separated names.
 *
 * Read from process.env rather than the parsed env module on purpose: this is
 * an operator-side switch that must be answerable without a schema change, and
 * an absent or empty value means nothing may be forwarded. Configuration names
 * a variable; only the operator decides the worker may hand its value to a
 * tenant's command.
 */
export const PRE_PR_ALLOWED_ENV_VAR = "PRE_PR_CHECKS_ALLOWED_ENV";

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
   * standing for the failures it could not carry. `env` is a variable the
   * repository's scripts declared that the worker refused to forward: not
   * allowlisted, or allowlisted and unset. Nothing of that repository ran, so
   * it is not a command's result either.
   *
   * Everything with a phase is excluded from the sentences that only make
   * sense for an ordinary failing check.
   */
  phase?: "setup" | "workspace" | "batch" | "omitted" | "env";
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
  /**
   * The repository script group this command was run for.
   *
   * A command shared by two selected groups belongs to the first of them, the
   * same rule the expansion uses when it deduplicates: it runs once, so it can
   * only have one verdict. Legacy configurations, which have no groups, land in
   * "checks".
   */
  group: string;
  /** Wall clock the command took, as the batch script measured it. Zero when
   *  the batch could not record it (an image whose `date` has no %N). */
  durationMs: number;
  /** The per-command timeout killed it. Distinct from a command that failed:
   *  nothing about the repository was verified by it either way, but only one
   *  of the two is answered by raising a bound. */
  timedOut: boolean;
}

/**
 * What one repository script group did.
 *
 * `passed` requires every one of the group's commands to have recorded exit 0:
 * a group that only partly ran is never a pass, because the whole point of the
 * gate is that a batch which did not finish must not read as verified.
 * `not_run` is that case and the plainer one it generalises, a group none of
 * whose commands started (a batch stall, a setup failure, a refused
 * environment). `skipped` is a group this run did not ask for, or every group
 * of a repository the workspace never attached or that the agent never touched.
 */
export type RepoScriptsGroupStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "skipped"
  | "not_run";

export interface RepoScriptsGroupStatusEntry {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  group: string;
  status: RepoScriptsGroupStatus;
}

/**
 * What a repository's tree looked like around one batch.
 *
 * Untracked files are deliberately absent from both lists: the publication gate
 * ignores them, and a build's artefacts would otherwise fill this every run.
 */
export interface RepoScriptsDirtiedRepo {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  /** Tracked files this batch's own commands modified. Restored afterwards
   *  unless the selection includes a group with restoreTree false. */
  files: string[];
  /** Tracked files that were already modified before the batch started: the
   *  agent's uncommitted work. Never restored, and never confused with the
   *  list above, because reverting it would destroy the run's actual output. */
  preExisting: string[];
}

export interface PrePrCheckRunResult {
  outcome: Exclude<CheckOutcome, "skipped">;
  passed: boolean;
  /** @deprecated Always 0: the repair loop is gone. Kept so the graph output
   *  contract (block-registry.ts) and agent.ts keep compiling until stage 3
   *  drops the field. */
  fixCycles: number;
  /** @deprecated Always empty, for the same reason as fixCycles. */
  fixCycleUsages: Array<PhaseUsage | null>;
  budgetFailure: RunBudgetFailure | null;
  /** Every normally started command, in workspace/repository and authored command order. */
  results: PrePrCheckCommandResult[];
  failures: PrePrCheckFailure[];
  /**
   * One entry per group of every repository this run reached, selected or not.
   *
   * "Reached" rather than "configured": a stalled batch stops the walk, because
   * a dead sandbox makes every later repository's result meaningless, and
   * inventing entries for repositories nothing was asked about would be the
   * same lie in a different column.
   */
  groupStatuses: RepoScriptsGroupStatusEntry[];
  /** Repositories whose tracked files the commands modified. */
  dirtied: RepoScriptsDirtiedRepo[];
  /** True when at least one repository's setup phase failed. */
  setupFailed: boolean;
  summary: string;
  /** @deprecated Never set: no agent is launched from this path any more. */
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
  /** Wall clock each single command gets. See DEFAULT_COMMAND_TIMEOUT_MINUTES. */
  commandTimeoutSeconds?: number;
  /**
   * File whose existence means this repository's setup already succeeded in
   * this sandbox, so it may be skipped.
   *
   * Deliberately outside every repository tree (see setupMarkerPath): anything
   * the batch writes inside one would show up in the tree-cleanliness check
   * below, and a marker that dirties the workspace it is meant to protect is
   * worse than no marker. Its name carries a hash of the setup array, so
   * editing a setup command invalidates it rather than silently keeping the
   * old provisioning.
   */
  setupMarker?: string | null;
  /**
   * Whether tracked files this batch modified are put back.
   *
   * False for a selection that includes a group whose job is to edit the tree
   * (a formatter run with --write). The modifications are still recorded and
   * reported; they are simply left in place for the run to commit.
   */
  restoreTree?: boolean;
}): string {
  const { paths, localPath, setup, commands } = opts;
  const timeoutSeconds =
    opts.commandTimeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_MINUTES * 60;
  const setupMarker = opts.setupMarker ?? null;
  const restoreTree = opts.restoreTree ?? true;
  const setupLines = setup.map((command, index) =>
    [
      `run_pre_pr_command ${index} ${shellQuote(command)}`,
      // A setup failure means the toolchain is missing, so this repository's
      // checks would only report the same thing once per command. Stop here and
      // record where; the caller still runs the other repositories.
      `[ "$PRE_PR_EXIT" -eq 0 ] || stop_batch ${index}`,
    ].join("\n"),
  );
  // Setup is idempotent per sandbox: the marker is written only after every
  // setup command succeeded, so a run whose provisioning failed re-runs it, and
  // one whose provisioning worked pays for it once however many batches follow.
  // The skip is recorded, because a collector that finds no exit status for a
  // setup command reports the batch as interrupted, and that would turn the
  // optimisation into a fabricated failure.
  const setupBlock =
    setup.length === 0
      ? ""
      : setupMarker === null
        ? setupLines.join("\n")
        : [
            `if [ -f ${shellQuote(setupMarker)} ]; then`,
            `  echo 1 > ${paths.dir}/setup-skipped`,
            "else",
            ...setupLines.map((line) =>
              line
                .split("\n")
                .map((part) => `  ${part}`)
                .join("\n"),
            ),
            // A marker that could not be written must not pass silently: the
            // batch is correct either way, but every later batch in this
            // sandbox re-runs provisioning it did not need to, and nothing
            // would say why.
            `  touch ${shellQuote(setupMarker)} 2>/dev/null || echo 1 > ${paths.dir}/setup-marker-failed`,
            "fi",
          ].join("\n");
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

# Both clock readings are forced to digits before any arithmetic touches them.
# Not defensive noise: an arithmetic expansion error is fatal to the whole
# compound command it sits in, so on an image whose \`date\` does not implement
# %N (BSD date, busybox) a raw \`$(( ... ))\` here silently skips the rest of the
# enclosing if-block, which is where the setup marker is written. Verified by
# running this wrapper under a BSD date. A duration of 0 means "not measured".
now_ms() {
  PRE_PR_NOW=$(date +%s%3N)
  case "$PRE_PR_NOW" in *[!0-9]*) PRE_PR_NOW=0 ;; esac
}

run_pre_pr_command() {
  now_ms; PRE_PR_STARTED_AT=$PRE_PR_NOW
  # Bounded per command, not per batch. \`timeout\` exits ${COMMAND_TIMEOUT_EXIT_CODE} when it had to
  # kill the command, which is what the collector reads as "timed out" rather
  # than as the command's own verdict. -k gives the runner ${COMMAND_TIMEOUT_KILL_GRACE_SECONDS}s to flush its
  # output file before SIGKILL. What this does not reach is the command's own
  # children, exactly as the missing trap above does not: an orphan keeps
  # burning sandbox CPU until teardown, which is waste, not a wrong result.
  timeout -k ${COMMAND_TIMEOUT_KILL_GRACE_SECONDS}s ${timeoutSeconds}s bash -lc "$2" > ${paths.dir}/stdout-$1 2> ${paths.dir}/stderr-$1
  PRE_PR_EXIT=$?
  now_ms
  echo "$PRE_PR_EXIT" > ${paths.dir}/exit-$1
  echo "$(( PRE_PR_NOW - PRE_PR_STARTED_AT ))" > ${paths.dir}/duration-$1
}

# --- Tree cleanliness ---
# Checks are supposed to verify the tree, not edit it, and a formatter or a
# code generator that rewrites tracked files silently changes what gets pushed
# after the gate has already passed on something else. So the batch takes a
# snapshot of what is already dirty BEFORE its first command, and afterwards
# restores only the files that were clean then and are dirty now.
#
# The snapshot is the whole point, and its absence was a data loss bug: a blunt
# \`git checkout -- .\` reverts the worktree to the index, which throws away
# whatever the agent left uncommitted, in a workspace where uncommitted work is
# the normal state between an implementation phase and its commit. Restoring
# per file, and only files this batch dirtied, cannot touch the agent's work.
#
# \`git checkout HEAD -- <file>\` rather than \`git checkout -- <file>\`: the
# former restores the index as well, so a command that staged its edit is undone
# too, while the latter would leave the staged copy behind for the publication
# gate to find.
#
# Untracked files are left alone throughout: build output is not a modification,
# and the publication gate ignores them.
snapshot_tree_state() {
  [ "$PRE_PR_IN_REPO" = "1" ] || return 0
  git status --porcelain=v1 --untracked-files=no | cut -c4- | LC_ALL=C sort -u > ${paths.dir}/dirty-before 2>/dev/null
}

record_tree_state() {
  [ "$PRE_PR_IN_REPO" = "1" ] || return 0
  git status --porcelain=v1 --untracked-files=no | cut -c4- | LC_ALL=C sort -u > ${paths.dir}/dirty-after 2>/dev/null
  # comm -13 prints the lines only in the second file: dirty now, clean before.
  # Both sides are sorted with the same collation, which comm requires.
  comm -13 ${paths.dir}/dirty-before ${paths.dir}/dirty-after > ${paths.dir}/dirty 2>/dev/null
${
  restoreTree
    ? `  while IFS= read -r PRE_PR_FILE; do
    [ -n "$PRE_PR_FILE" ] || continue
    # A staged rename arrives as "old -> new" and both sides have to come back.
    case "$PRE_PR_FILE" in
      *" -> "*) git checkout HEAD -- "\${PRE_PR_FILE%% -> *}" "\${PRE_PR_FILE##* -> }" >/dev/null 2>&1 ;;
      *) git checkout HEAD -- "$PRE_PR_FILE" >/dev/null 2>&1 ;;
    esac
  done < ${paths.dir}/dirty`
    : `  # restoreTree is off for this selection: a group whose job is to edit the
  # tree keeps its edits. They are still recorded in dirty above.`
}
}

stop_batch() {
  echo "$1" > ${paths.dir}/stopped-at
  record_tree_state
  touch ${paths.sentinel}
  exit 0
}

cd ${shellQuote(localPath)} || stop_batch ${BATCH_NO_COMMAND_RAN}
# Only now may the tree be inspected: before the cd, \`git status\` would
# describe whatever repository the wrapper happened to start in.
PRE_PR_IN_REPO=1
# Before setup, not after: a provisioning command that rewrites a lockfile has
# dirtied the tree as surely as a check would, and it must be restored too.
snapshot_tree_state

${[setupBlock, ...checkLines].filter(Boolean).join("\n")}

record_tree_state

# --- Signal completion, last, once every output file is written ---
touch ${paths.sentinel}
`;
}

/**
 * Per-command timeout that actually applies, in minutes.
 *
 * The repository's own value wins, then the operator's, then the constant. Read
 * from process.env rather than the parsed env module because that module is
 * out of this change's reach; a nonsense value falls back rather than throwing,
 * since a malformed operator variable must not stop every check in the fleet.
 */
export function resolveCommandTimeoutMinutes(configured?: number): number {
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured >= 1
  ) {
    return Math.floor(configured);
  }
  const raw = process.env.PRE_PR_COMMAND_TIMEOUT_MINUTES;
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_COMMAND_TIMEOUT_MINUTES;
}

/** Names, with values, the worker is willing to hand to a tenant's commands. */
export interface ResolvedRepoEnv {
  values: Record<string, string>;
  /** Configured names that will not be forwarded, and why. Never a value. */
  rejected: Array<{ name: string; reason: "not_allowed" | "unset" }>;
}

/**
 * Resolve a repository's declared environment names against the worker's own
 * process environment, gated by the operator allowlist.
 *
 * Two independent gates on purpose. Configuration is authored in the dashboard
 * and names a variable; the allowlist is deployment state and decides which
 * names the worker's environment is willing to expose at all. Without the
 * second gate, anyone who can edit a repository's scripts can exfiltrate any
 * secret the worker holds by naming it and printing it.
 */
export function resolveRepoEnv(names: string[]): ResolvedRepoEnv {
  const allowed = new Set(
    (process.env[PRE_PR_ALLOWED_ENV_VAR] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const values: Record<string, string> = {};
  const rejected: ResolvedRepoEnv["rejected"] = [];
  for (const name of names) {
    if (!allowed.has(name)) {
      rejected.push({ name, reason: "not_allowed" });
      continue;
    }
    const value = process.env[name];
    // An empty value is treated as unset: forwarding "" reads to a command as
    // a configured-but-blank credential, which fails later and further away.
    if (value === undefined || value === "") {
      rejected.push({ name, reason: "unset" });
      continue;
    }
    values[name] = value;
  }
  return { values, rejected };
}

/**
 * The failure a repository gets when its environment could not be resolved.
 *
 * Loud rather than silent, and per repository rather than per name, so an
 * operator reads one sentence naming every variable to fix. Names only: this
 * text is persisted in the run's event log and shown in the run summary.
 */
export function repoEnvFailure(
  provider: WorkspaceRepo["provider"],
  repoPath: string,
  rejected: ResolvedRepoEnv["rejected"],
): PrePrCheckFailure {
  const notAllowed = rejected
    .filter((entry) => entry.reason === "not_allowed")
    .map((entry) => entry.name);
  const unset = rejected
    .filter((entry) => entry.reason === "unset")
    .map((entry) => entry.name);
  const sentences: string[] = [];
  if (notAllowed.length > 0) {
    sentences.push(
      `${notAllowed.join(", ")} ${notAllowed.length === 1 ? "is" : "are"} not in ` +
        `${PRE_PR_ALLOWED_ENV_VAR}, so the worker refused to forward ` +
        `${notAllowed.length === 1 ? "it" : "them"}.`,
    );
  }
  if (unset.length > 0) {
    sentences.push(
      `${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} allowed but not ` +
        `set in the worker environment.`,
    );
  }
  return batchFailure(
    provider,
    repoPath,
    "(repository environment)",
    `${sentences.join(" ")} Not one of this repository's commands ran. ` +
      `Fix the repository's env list, or add the variable to ${PRE_PR_ALLOWED_ENV_VAR} ` +
      "and redeploy the worker.",
    "env",
  );
}

/** Extra inputs the batch start step takes on top of what a legacy pre-PR
 *  check batch needed. Bundled rather than appended positionally: the step is
 *  already at the limit of what a positional signature can carry. */
export interface RepoCheckBatchStartOptions {
  /** Worker environment variable NAMES to forward to the batch process. */
  envNames?: string[];
  /** The repository's own per-command bound, in minutes, if it set one. */
  commandTimeoutMinutes?: number;
  /** Whether the batch restores the tracked files its commands modified.
   *  Default true; false for a selection that includes a tree-editing group. */
  restoreTree?: boolean;
}

/**
 * Write and launch one repository's check batch, detached, and return at once.
 *
 * Returns `skipped` when the repository is not in this run's workspace, and,
 * under `requireChange`, when its HEAD never moved: the same filter the
 * blocking runner applied before running any command. Returns an `envFailure`
 * when a declared environment variable could not be forwarded: nothing is
 * written and nothing is launched, so the repository has no result at all.
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
  options: RepoCheckBatchStartOptions = {},
): Promise<
  | { skipped: true }
  | { skipped: false; envFailure: PrePrCheckFailure }
  | {
      skipped: false;
      envFailure?: undefined;
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

  // Resolved inside the step, never in workflow scope: a value resolved out
  // there would travel here as a step argument, and every step argument is
  // persisted in the run's event log. A rejection stops the repository before
  // anything is written, so a misconfigured secret cannot half-run a batch.
  const resolvedEnv = resolveRepoEnv(options.envNames ?? []);
  if (resolvedEnv.rejected.length > 0) {
    return {
      skipped: false,
      envFailure: repoEnvFailure(provider, repoPath, resolvedEnv.rejected),
    };
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
          commandTimeoutSeconds:
            resolveCommandTimeoutMinutes(options.commandTimeoutMinutes) * 60,
          setupMarker: setup.length > 0 ? await setupMarkerPath(repo.slug, setup) : null,
          restoreTree: options.restoreTree ?? true,
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
    // The one channel a forwarded value travels: the SDK hands it to the
    // process, children of the wrapper inherit it, and it exists nowhere the
    // sandbox or the event log can keep it. Never interpolated into the script,
    // because the script is a file the sandbox holds for the life of the run.
    env: resolvedEnv.values,
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

/**
 * Where one repository's setup marker lives, hashed by the setup array.
 *
 * /tmp, not the workspace root. It is the sandbox's own scratch space, proven
 * writable by everything this path already puts there (the wrapper, the
 * sentinel, the per-command output directory) and by the shared git excludes
 * file at REPOSITORY_EXCLUDES_PATH. Above all it is outside every checkout, so
 * no marker can appear in a `git status` or be offered for commit; a marker
 * under the workspace root would have needed a new pattern in
 * sandbox/git-excludes.ts to stay invisible, and an unexcluded one would dirty
 * the very tree this mechanism protects.
 *
 * Web Crypto rather than node:crypto, and for the same reason newLaunchId is:
 * this module is statically imported by workflow-scope block modules, and a
 * Node builtin in that import graph fails only the Vercel build, never vitest
 * or a local one.
 */
export async function setupMarkerPath(slug: string, setup: string[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(setup)),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
  return `/tmp/aiw-setup-${slug}-${hash}`;
}

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
   * An authored setup command failed, so this repository's own commands never
   * ran.
   *
   * A workspace directory that could not be entered is deliberately NOT one of
   * these: no setup command was authored, so nothing about it is the operator's
   * configuration and no operator can go and fix it. Those arrive as failures
   * carrying phase "workspace", which is what callers filter on.
   */
  setupFailed: boolean;
  /** Tracked files THIS BATCH modified: dirty after its commands and clean
   *  before them. Restored unless the selection turned restoreTree off. */
  dirtied: string[];
  /** Tracked files already modified when the batch started, which is the
   *  agent's own uncommitted work. Never touched and never restored; reported
   *  so a caller can tell it apart from dirt a command caused. */
  preExistingDirty: string[];
  /** The setup marker could not be written, so provisioning will run again in
   *  every later batch of this sandbox. Not a failure: the batch is correct,
   *  it is only slower, and an operator should still be able to find out. */
  setupMarkerFailed: boolean;
  progress: RepoCheckBatchProgress;
}

/** Extra inputs the collect step takes, bundled for the same reason the start
 *  step's are. */
export interface RepoCheckBatchCollectOptions {
  /** Group each check command belongs to, parallel to `commands`. Absent for
   *  the explicit-commands mode of run_checks, which has no groups. */
  commandGroups?: string[];
  /** Env var NAMES that were forwarded to this batch. Their values are
   *  re-resolved here and scrubbed out of everything this step returns. */
  envNames?: string[];
  /** Minutes each command was given, so a timeout can say which bound bit. */
  commandTimeoutMinutes?: number;
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
  options: RepoCheckBatchCollectOptions = {},
): Promise<CollectedRepoCheckBatch> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const total = setup.length + commands.length;
  const commandAt = (index: number): string =>
    index < setup.length ? setup[index]! : commands[index - setup.length]!;
  // Legacy configurations have no groups, and neither does the explicit
  // commands mode of run_checks, so both land in the same single group the
  // config normalizer gives a flat command list.
  const groupAt = (index: number): string =>
    options.commandGroups?.[index - setup.length] ?? LEGACY_GROUP_NAME;
  const timeoutMinutes = resolveCommandTimeoutMinutes(options.commandTimeoutMinutes);
  // Re-resolved here rather than carried from the start step, because carrying
  // it would mean a secret value sitting in a step argument in the event log.
  // Same names, same worker, same process.env.
  const secrets = scrubbableValues(options.envNames ?? []);
  const emptyProgress: RepoCheckBatchProgress = { completed: 0, total, stoppedAt: null };
  const workspaceIncident = (reason: string): CollectedRepoCheckBatch => ({
    results: [],
    failures: [batchFailure(provider, repoPath, "(check batch)", reason, "workspace")],
    setupFailed: false,
    dirtied: [],
    preExistingDirty: [],
    setupMarkerFailed: false,
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
      dirtied: [],
      preExistingDirty: [],
      setupMarkerFailed: false,
      progress: emptyProgress,
    };
  }

  // Setup that the marker skipped left no exit files, and a collector that
  // reads a missing exit as an interrupted batch would turn the skip into a
  // fabricated failure for every setup command.
  const setupSkipped = (files.get("setup-skipped")?.bytes ?? -1) > 0;
  const setupMarkerFailed = (files.get("setup-marker-failed")?.bytes ?? -1) > 0;
  if (setupMarkerFailed) {
    // Logged rather than failed: nothing about the batch's verdict is wrong,
    // but every later batch in this sandbox pays for provisioning again and
    // without this line there would be nothing anywhere saying why.
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { provider, repoPath },
      "pre_pr_checks_setup_marker_unwritable",
    );
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
    if (isSetup && setupSkipped) {
      // Provisioning this sandbox already did, so it counts as done rather than
      // as a command that vanished: an operator reading "2 of 4 commands had
      // finished" for a batch that ran everything it needed to would go looking
      // for a stall that never happened.
      completed++;
      continue;
    }
    const exitFile = files.get(`exit-${index}`);
    const exitText = exitFile ? decodeBatchFile(exitFile) : "";
    const exitCode = /^-?\d+$/.test(exitText) ? Number(exitText) : null;
    const durationText = decodeBatchFile(
      files.get(`duration-${index}`) ?? { bytes: -1, head: "", tail: null, blocked: false },
    );
    const durationMs = /^\d+$/.test(durationText) ? Number(durationText) : 0;
    // Exit 124 alone is not proof: it is an ordinary exit code that a command
    // is free to return on its own, and calling that a timeout tells an
    // operator to raise a bound that was never reached. The duration has to
    // corroborate it, at the bound less a margin for the process teardown that
    // happens after `timeout` fires. When the duration could not be measured at
    // all it reads 0, so the command is reported as an ordinary failure, which
    // is the safe direction: understating a timeout costs a slower diagnosis,
    // overstating one sends the operator to change the wrong setting.
    const timedOut =
      exitCode === COMMAND_TIMEOUT_EXIT_CODE &&
      durationMs >= timeoutMinutes * 60_000 * COMMAND_TIMEOUT_DURATION_RATIO;

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
        stdout: streamText(files.get(`stdout-${index}`), secrets),
        stderr: streamText(files.get(`stderr-${index}`), secrets),
        note: BATCH_MISSING_EXIT_REASON,
        ...(isSetup ? { phase: "setup" as const } : {}),
      });
      if (isSetup) setupFailed = true;
      continue;
    }

    completed++;
    const stdout = streamText(files.get(`stdout-${index}`), secrets);
    const stderr = streamText(files.get(`stderr-${index}`), secrets);

    if (isSetup) {
      if (exitCode !== 0) {
        setupFailed = true;
        failures.push({
          provider,
          repoPath,
          command,
          exitCode,
          stdout,
          stderr,
          ...(timedOut ? { note: timedOutNote(timeoutMinutes) } : {}),
          phase: "setup",
        });
      }
      continue;
    }

    results.push({
      provider,
      repoPath,
      command,
      exitCode,
      group: groupAt(index),
      durationMs,
      timedOut,
    });
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
        // A timeout and a blocked dependency cannot both apply: one exits 124,
        // the other exits 0.
        ...(timedOut
          ? { note: timedOutNote(timeoutMinutes) }
          : blockedByMissingDependencies
            ? { note: MISSING_DEPENDENCY_FAILURE_REASON }
            : {}),
      });
    }
  }

  return {
    results,
    // The ordering guarantee: every byte of every stream was scrubbed by
    // decodeBatchFile as it was decoded, edges included, so no value survives
    // into this array at all. finalizeBatchFailures then bounds already clean
    // text, and the only thing its head-and-tail cut can bisect is a
    // `[redacted:NAME]` marker. Scrubbing after this call instead would be a
    // silent leak: the bound cuts at an arbitrary offset, and a value halved by
    // it is a value a whole-string replace can no longer find.
    failures: finalizeBatchFailures(failures),
    setupFailed,
    // Not scrubbed: these are the paths git reported, not command output, and
    // no forwarded value can reach a tracked file name.
    dirtied: parseDirtyFiles(streamText(files.get("dirty"))),
    preExistingDirty: parseDirtyFiles(streamText(files.get("dirty-before"))),
    setupMarkerFailed,
    progress: { completed, total, stoppedAt: stoppedAtCommand },
  };
}
collectRepoCheckBatchStep.maxRetries = 0;

/**
 * Every occurrence of every forwarded value, replaced by its own name.
 *
 * Applied regardless of whether a name looks like a secret to the observability
 * redactor: the operator allowlisted it for forwarding, which is the only
 * signal that matters, and a check tool that echoes its arguments does not care
 * what the variable is called. Longest values first, so a value that contains
 * another is replaced as a whole rather than leaving a half-redacted tail.
 */
export function scrubEnvValues(
  text: string,
  secrets: Array<{ name: string; value: string }>,
): string {
  let scrubbed = text;
  for (const { name, value } of secrets) {
    if (!value) continue;
    scrubbed = scrubbed.split(value).join(`[redacted:${name}]`);
  }
  return scrubbed;
}

/**
 * Shortest fragment of a value that is still treated as the value.
 *
 * A bound in both directions. Below it, a fragment is short enough that
 * ordinary output collides with it constantly and the redaction would eat real
 * text at every truncation; at it and above, four characters of a credential
 * are four characters an attacker does not have to guess, and no run needs
 * them. Values shorter than this get no fragment protection at all, which is
 * acceptable because nothing that short is a credential.
 */
const MIN_SECRET_FRAGMENT_CHARS = 4;

/**
 * Strip a value's leading fragment from the END of a truncated head slice.
 *
 * The head slice was cut at a fixed byte offset, so a value that began just
 * before that offset survives as its own prefix. Longest overlap first, and
 * only one value can match: there is one cut, and the bytes at it are one
 * string. Whole values are already gone by the time this runs.
 */
function scrubTruncatedEnd(
  text: string,
  secrets: Array<{ name: string; value: string }>,
): string {
  for (const { name, value } of secrets) {
    const longest = Math.min(value.length - 1, text.length);
    for (let length = longest; length >= MIN_SECRET_FRAGMENT_CHARS; length--) {
      if (text.endsWith(value.slice(0, length))) {
        return `${text.slice(0, text.length - length)}[redacted:${name}]`;
      }
    }
  }
  return text;
}

/** The mirror image: a value's trailing fragment at the START of a tail slice. */
function scrubTruncatedStart(
  text: string,
  secrets: Array<{ name: string; value: string }>,
): string {
  for (const { name, value } of secrets) {
    const longest = Math.min(value.length - 1, text.length);
    for (let length = longest; length >= MIN_SECRET_FRAGMENT_CHARS; length--) {
      if (text.startsWith(value.slice(value.length - length))) {
        return `[redacted:${name}]${text.slice(length)}`;
      }
    }
  }
  return text;
}

function scrubbableValues(names: string[]): Array<{ name: string; value: string }> {
  return names
    .map((name) => ({ name, value: process.env[name] ?? "" }))
    .filter((entry) => entry.value !== "")
    .sort((left, right) => right.value.length - left.value.length);
}

/**
 * Paths out of the tree-cleanliness record.
 *
 * The batch script already stripped porcelain's two status columns with
 * `cut -c4-`, so each line is a path. A rename arrives as `old -> new` and the
 * new name is the one that exists; a path with special characters arrives
 * quoted, exactly as git quoted it, which is left alone rather than half
 * unescaped by a parser that would then disagree with git.
 */
function parseDirtyFiles(text: string): string[] {
  return text
    .split("\n")
    .map((line) => {
      const renamed = line.split(" -> ");
      return (renamed[renamed.length - 1] ?? "").trim();
    })
    .filter((path) => path.length > 0);
}

function timedOutNote(minutes: number): string {
  return (
    `This command timed out after ${minutes} minute${minutes === 1 ? "" : "s"} and was ` +
    "killed, so it never reported a result: this is neither a passing nor a failing " +
    "check. Raise commandTimeoutMinutes for this repository, or " +
    "PRE_PR_COMMAND_TIMEOUT_MINUTES for the deployment, if the command legitimately " +
    "needs longer."
  );
}

/** Where a flat command list lands once it is normalized to groups. Legacy
 *  stored configurations and the explicit-commands mode both have exactly one. */
const LEGACY_GROUP_NAME = "checks";

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
  const names = [
    "launch",
    "stopped-at",
    "setup-skipped",
    "setup-marker-failed",
    "dirty",
    "dirty-before",
  ];
  for (let index = 0; index < total; index++) {
    names.push(`exit-${index}`, `stdout-${index}`, `stderr-${index}`, `duration-${index}`);
  }
  const script = buildBatchReaderScript({ dir: paths.dir, names });
  const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script] });
  if (result.exitCode !== 0) return { ok: false, files: new Map() };
  return { ok: true, files: parseBatchReaderOutput(await result.stdout()) };
}

/**
 * Decode one read back to text, splicing in what the reader left out, and
 * remove every forwarded value from what comes out.
 *
 * Scrubbing lives HERE and not at the end of the collect, because this is the
 * only place that still knows where the sandbox reader cut. The reader carries
 * back a 2KB head and a 2KB tail of an oversized stream, so a value straddling
 * either cut arrives already halved, and a whole-string replace cannot find a
 * half. The two slices are therefore scrubbed independently (a value cannot
 * span the omitted middle: those bytes never left the sandbox) and then their
 * truncated edges are scrubbed again for a fragment.
 *
 * A value CANNOT be plumbed into the reader instead. That script is written to
 * the sandbox filesystem and its argv is visible to every process in the box,
 * so grepping for a secret there would put the secret in exactly the two places
 * this whole mechanism exists to keep it out of.
 */
function decodeBatchFile(
  file: BatchFileRead,
  secrets: Array<{ name: string; value: string }> = [],
): string {
  if (file.bytes < 0) return "";
  const head = Buffer.from(file.head, "base64").toString("utf8");
  // Not truncated: the reader carried the whole file, so no edge is a cut and
  // a whole-value replace is exhaustive.
  if (file.tail === null) return scrubEnvValues(head.trim(), secrets);
  const omitted = file.bytes - BATCH_STREAM_HEAD_BYTES - BATCH_STREAM_TAIL_BYTES;
  const tail = Buffer.from(file.tail, "base64").toString("utf8");
  // trimStart on the head and trimEnd on the tail, deliberately: each leaves
  // the CUT edge untouched, which is the edge the fragment scrub inspects.
  const scrubbedHead = scrubTruncatedEnd(
    scrubEnvValues(head.trimStart(), secrets),
    secrets,
  );
  const scrubbedTail = scrubTruncatedStart(
    scrubEnvValues(tail.trimEnd(), secrets),
    secrets,
  );
  return `${scrubbedHead}\n[... ${omitted} bytes of this command's output omitted ...]\n${scrubbedTail}`;
}

function streamText(
  file: BatchFileRead | undefined,
  secrets: Array<{ name: string; value: string }> = [],
): string {
  return file ? decodeBatchFile(file, secrets) : "";
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

/** Why a polled batch produced no sentinel. `none` means it finished. */
export type PrePrPhaseStall = "none" | "timed_out" | "sandbox_stopped";

export function formatPrePrCheckFailures(failures: PrePrCheckFailure[]): string {
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
                : failure.phase === "env"
                  ? `ENVIRONMENT UNAVAILABLE for ${repoKey}`
                  : repoKey,
        `Command: ${failure.command}`,
        `Exit code: ${failure.exitCode}`,
        output ? `Output:\n${output}` : "Output: (empty)",
        // After the output and outside the bound: the note explains the entry
        // and must survive whatever truncation the output took.
        ...(failure.note ? [failure.note] : []),
        ...(failure.phase === "setup" ? [SETUP_FAILURE_REASON] : []),
        ...(failure.phase === "workspace" ? [WORKSPACE_FAILURE_REASON] : []),
      ].join("\n");
    })
    .join("\n\n");
}

const SETUP_FAILURE_REASON =
  "This is a setup command, not a check: it runs once before this repository's " +
  "scripts to provision its toolchain. The repository's remaining commands were " +
  "skipped, because nothing they could report would describe anything but the " +
  "missing toolchain. Fix the setup command in the repository scripts " +
  "configuration.";

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
  "editing; the other repositories are unaffected.";

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
