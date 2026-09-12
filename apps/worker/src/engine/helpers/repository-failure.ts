/* eslint-disable max-lines, max-lines-per-function */
import type { WorkflowExecutionErrorState } from "@shared/contracts";
import { type StepsRecord } from "../../workflow-definition/interpreter.js";
import type { BlockExecutionContext } from "../../workflow-definition/interpreter.js";
import { type EngineCtx } from "../blocks/support/types.js";
import { asRepositoryScriptsOutput, repositoryScriptCoverageNotes, REPOSITORY_SCRIPTS_ABANDONED_CLASS, REPOSITORY_SCRIPTS_BUDGET_CLASS, REPOSITORY_SCRIPTS_FAILED_CLASS, REPOSITORY_SCRIPTS_NOT_STARTED_CLASS, REPOSITORY_SCRIPTS_NOTHING_RAN_CLASS, type RepositoryScriptsOutput } from "../blocks/support/repository-scripts-output.js";
import { isChecksCeilingExceededError, isDurationAbortError, isV2InvocationCancelledError, type RunBudgetAttribution, type RunBudgetObservation } from "./run-budget.js";
import { redactDiagnosticText } from "../../sandbox/agents/redact.js";
import { isRunControlError } from "./run-control-error.js";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function truncateError(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text;
}

/** Longest failure cause carried into the Pre-PR checks failure message.
 *  Same bound the Pre-PR repair launch failure puts on its carried cause
 *  (#309): long enough for a sandbox, kill or stream verdict, short enough that
 *  the composed block failure stays a detail rather than a payload. */
export const PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH = 200;

/** Stack tail kept for the log record only, never for the operator message:
 *  frames leak internal paths and are what turns a detail into a firehose. */
export const PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH = 600;

type BoundaryCapableBudgetObserver = (
  requireRemainingDuration?: boolean,
  attribution?: RunBudgetAttribution,
  observedAtMs?: number,
) => Promise<RunBudgetObservation>;

function checksBudgetObserver(
  ctx: Pick<EngineCtx, "observeBudget">,
  execution?: BlockExecutionContext,
): (
  requireRemainingDuration?: boolean,
  observedAtMs?: number,
) => Promise<RunBudgetObservation> {
  const observe = (execution?.observeBudget ?? ctx.observeBudget) as BoundaryCapableBudgetObserver;
  return (requireRemainingDuration, observedAtMs) =>
    observe(requireRemainingDuration, "checks", observedAtMs);
}

/**
 * Errors the Pre-PR checks call site must rethrow untouched.
 *
 * These predicates identify errors structurally because Workflow serializes
 * step errors across VMs. Wrapping one in a new Error destroys the identity
 * the call site depends on, so checks ceilings, aborts and cancellations must
 * pass through unchanged.
 */
export function prePrChecksFailureMustPropagate(error: unknown): boolean {
  return (
    isRunControlError(error) ||
    isChecksCeilingExceededError(error) ||
    isDurationAbortError(error) ||
    isV2InvocationCancelledError(error)
  );
}

/**
 * The parts of a thrown value the failure report needs, flattened where the
 * throw is caught.
 *
 * A separate shape because the report is now composed inside a step and the
 * catch is in workflow scope: Workflow serializes step arguments, and an Error
 * does not survive that. Its name, its `code` and its stack are all dropped,
 * which is every field the report is made of. Flattening here keeps the
 * `instanceof Error` question where the real value still exists.
 */
export interface PrePrChecksFailureInput {
  /** `error.name`, or the `typeof` of a non-Error throw. Log record only. */
  name: string;
  message: string;
  /**
   * What to prefix the cause with: the class name, or empty for a non-Error
   * throw, whose `typeof` would only add noise to its own text.
   *
   * The class name is all there is to prefix with. This catch sits in workflow
   * scope and every error it sees was thrown inside a step, and Workflow
   * reduces a thrown error to its name, message and stack at the VM boundary
   * and revives it as a plain Error on this side. A system error code
   * (`ECONNREFUSED`) would name the cause far better than `Error` does, but
   * `.code` is gone by the time anything here can read it. Recovering it would
   * mean parsing the message, the way isReplayedRunControlStepError parses for
   * run-control errors, and no incident has yet asked for it.
   */
  label: string;
  stack: string;
}

/**
 * Flatten a thrown value into the parts the failure report needs, redacted and
 * bounded before it can go anywhere.
 *
 * Redacted here rather than in the step: Workflow journals step arguments
 * durably, so whatever this returns is written into the run's event log
 * verbatim. An SDK error carrying a `Bearer`, an `sk-ant-` or a `glpat-` in a
 * clone URL would otherwise be persisted in full, with the redaction
 * protecting only the sentence an operator reads. Redaction runs before
 * truncation so a secret is blanked rather than cut in half.
 *
 * The redactor runs in workflow scope here and again inside the step, and the
 * two cannot disagree within an invocation: the workflow VM shims `process` as
 * a frozen spread of `process.env` taken when the context is built, so both
 * sides read the same snapshot. The narrow consequence is that a secret added
 * or rotated AFTER the context was built is absent from that snapshot, so its
 * literal value would cross the boundary into the journal unblanked while the
 * operator's sentence stays clean. The pattern rules below (`sk-ant-`, `gh?_`,
 * `glpat-`, `Bearer`) do not depend on the environment and still catch it.
 *
 * Bounded here for the same reason: the step keeps exactly these bytes anyway,
 * so anything beyond them would be journaled and then dropped.
 *
 * Flattened at all because an Error does not survive step argument
 * serialization: its name, its `code` and its stack, which is every field the
 * report is made of, are dropped in transit.
 */
export function prePrChecksFailureInput(error: unknown): PrePrChecksFailureInput {
  const isError = error instanceof Error;
  const name = isError ? error.name : typeof error;
  const stack = isError ? error.stack ?? "" : "";
  return {
    name,
    message: redactDiagnosticText(isError ? error.message : String(error)).slice(
      0,
      PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH,
    ),
    label: isError ? name : "",
    stack: stack
      ? redactDiagnosticText(stack).slice(-PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH)
      : "",
  };
}

/**
 * What a Pre-PR checks failure is allowed to say, composed in one pure place
 * so the bound and the wording can be pinned directly.
 *
 * `redact` is a parameter rather than an import so this stays a pure function
 * that can be pinned against a stub redactor. The real one is imported
 * directly at the top of this module: it lives alone in
 * `sandbox/agents/redact.js` precisely so workflow scope may import it.
 */
export function prePrChecksFailureReport(
  error: PrePrChecksFailureInput,
  redact: (value: string) => string,
): { name: string; cause: string; stackTail: string; message: string } {
  const cause = redact(
    error.label && error.label !== "Error"
      ? `${error.label}: ${error.message}`
      : error.message,
  ).slice(0, PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH);
  return {
    name: error.name,
    cause,
    stackTail: error.stack
      ? redact(error.stack).slice(-PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH)
      : "",
    message: `The repository scripts step failed: ${cause}`,
  };
}

/**
 * What a failure comment reports about the repository scripts, recovered from
 * the walk's own durable step outputs.
 *
 * Recovered rather than carried. The engine's per-command summary is built
 * inside the block and published on its output, but the run fails at a LATER
 * node (finalize refusing an unmet checks input, or the block itself throwing),
 * and everything that crosses that boundary is one 600-character execution
 * error message. AIW-309 is exactly that boundary: the product knew which
 * command failed and could not say so.
 */
export interface RecoveredRepositoryScriptsFailure {
  outcome: RepositoryScriptsOutput["outcome"];
  summary: string;
  failures: RepositoryScriptsOutput["failures"];
  dirtied: RepositoryScriptsOutput["dirtied"];
  /** Optional, unlike the rest: the shared guard deliberately does not require
   *  it, so an output recorded by a deployment from before the field existed
   *  arrives without it. The comment defaults it to no coverage rather than
   *  losing the whole recovered failure over one absent key. */
  groupCoverage?: RepositoryScriptsOutput["groupCoverage"];
}

/**
 * The LATEST repository scripts output a run recorded, and only when that one
 * was not clean.
 *
 * Latest-recorded, deliberately, not latest-failing. A clean latest output is
 * positive evidence that the terminal failure was not produced by the scripts:
 * a definition that deliberately continues past a failing group (a wired
 * `failed` edge into a remediation branch) and then passes a later one has
 * already handled that failure, and attaching its output to whatever the run
 * died of afterwards would name a cause that was dealt with rounds ago. So a
 * clean latest run returns null and the failure keeps its own reason.
 *
 * The cost of that choice, stated rather than hidden: a genuinely relevant
 * earlier failure is not reported when a later scripts run passed. That is the
 * safe direction, because a missing appendix leaves the reason intact while a
 * wrong one actively misdirects.
 */
export function recoverLatestRepositoryScriptsFailureFromSteps(
  steps: StepsRecord,
): RecoveredRepositoryScriptsFailure | null {
  const outputs = Object.values(steps);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const scripts = asRepositoryScriptsOutput(
      outputs[index]?.output as Record<string, unknown> | undefined,
    );
    if (!scripts) continue;
    // A clean run is not evidence of anything a failure comment needs, and
    // appending it would attribute an unrelated failure to the scripts.
    if (scripts.outcome === "passed" && scripts.failures.length === 0) return null;
    return scripts;
  }
  return null;
}

/**
 * Failure phases whose comment is about the repository scripts.
 *
 * Deliberately a closed set. A run whose scripts failed can go on to fail
 * somewhere else entirely (a wired failure edge that then loses its sandbox),
 * and attaching the script report to that failure would name the wrong cause.
 * The members are the phases the two boundaries actually produce: the checks
 * CATEGORY, the publication gate's own phase, and the node types the v2
 * scheduler uses as the phase of a block that threw.
 *
 * "checks" is in here as a CATEGORY, not as a phase. finalize_workspace
 * refuses an unmet `checks.*` input with no phase at all, so both walk paths
 * have to fall back to the category before they key on this set, which is what
 * `failureExitPhase` exists to guarantee. The v2 path skipped that fallback and
 * reported "workflow", which silently disabled evidence recovery on the one
 * path production actually runs.
 */
const REPOSITORY_SCRIPTS_FAILURE_PHASES: ReadonlySet<string> = new Set([
  "checks",
  "pre-pr-checks",
  "run_scripts",
  "run_checks",
  "run_pre_pr_checks",
]);

export function isRepositoryScriptsFailurePhase(phase: string): boolean {
  return REPOSITORY_SCRIPTS_FAILURE_PHASES.has(phase);
}

/**
 * The phase a terminal execution error reports to the failure exit.
 *
 * The category is the fallback, exactly as the v1 interpreter's own finish()
 * does it. A block that composed its error without a phase is the normal case,
 * not an edge case: finalize's unmet-checks refusal is one, and reporting it as
 * a nameless "workflow" failure is what kept AIW-309's headline case posting a
 * bare comment on the v2 path.
 */
export function failureExitPhase(
  error: Pick<WorkflowExecutionErrorState, "phase" | "category">,
): string {
  return error.phase ?? error.category ?? "workflow";
}

/** Leads, one per class of script failure. They answer different questions, so
 *  a single sentence for all five is what made the report unreadable: a
 *  failing command, a broken toolchain, a selection that matched nothing, an
 *  exhausted budget and a batch stopped part way need five different actions. */
// Every one of them is the shared class stem ended with a full stop. The
// publication boundary refuses with the same words and runs.diagnose matches on
// them, so a copy here would rot the day one is reworded, and a class that
// existed only here would refuse with the wrong one: that is how a budget stop
// came to lead this comment with CHECKS BUDGET SPENT while the boundary called
// it a failing command.
const REPOSITORY_SCRIPTS_FAILED_LEAD = `${REPOSITORY_SCRIPTS_FAILED_CLASS}.`;

const REPOSITORY_SCRIPTS_NOT_STARTED_LEAD = `${REPOSITORY_SCRIPTS_NOT_STARTED_CLASS}.`;

const REPOSITORY_SCRIPTS_NOTHING_RAN_LEAD = `${REPOSITORY_SCRIPTS_NOTHING_RAN_CLASS}.`;

const REPOSITORY_SCRIPTS_BUDGET_LEAD = `${REPOSITORY_SCRIPTS_BUDGET_CLASS}.`;

const REPOSITORY_SCRIPTS_ABANDONED_LEAD = `${REPOSITORY_SCRIPTS_ABANDONED_CLASS}.`;

/** Appended when the definition still asks for repair cycles. The parameter is
 *  accepted and ignored by the engine, so without this the operator's only
 *  evidence is a repair that never happens. */
const REPAIR_CYCLES_REMOVED_NOTE =
  "This workflow definition still requests repair cycles (maxFixCycles), and the " +
  "repair loop was removed: nothing launches an agent to fix a failing script any more.";

/** Headings mirroring formatPrePrCheckFailures (pre-pr-checks/runner.ts), so
 *  the ticket comment and the block's own summary read the same way. */
const REPOSITORY_SCRIPT_PHASE_HEADINGS: Record<string, string> = {
  setup: "SETUP FAILED for",
  workspace: "WORKSPACE UNAVAILABLE for",
  batch: "CHECK BATCH ABANDONED for",
  omitted: "FAILURES OMITTED for",
  env: "ENVIRONMENT UNAVAILABLE for",
  budget: "CHECKS BUDGET SPENT before",
};

/**
 * Failures the comment renders in full before it starts counting.
 *
 * Each one already carries up to 2000 characters of bounded output, and this
 * text is a journaled step argument on its way to a ticket. Five failing
 * commands is more than enough to act on; a repository with fifty has one
 * cause, not fifty.
 */
const REPOSITORY_SCRIPT_FAILURES_SHOWN = 5;

/** Where the failures this comment did not render can still be read. A bare
 *  count told an operator something was missing and nothing about how to see
 *  it, which is the defect this whole stage exists to stop repeating. */
const REPOSITORY_SCRIPT_FAILURES_ELSEWHERE =
  "The full list is on the scripts block's `failures` output, in the run details view.";

/** Appended when no node of the definition could ever mint a publication gate,
 *  so Finalize was always going to refuse it. run_scripts deliberately records
 *  none, and a narrowed run_checks records none either; nothing else in the
 *  failure says so. */
const NO_GATE_BLOCK_NOTE =
  "This definition has no node that can record a publication gate before " +
  "Finalize Workspace: only run_pre_pr_checks, and a run_checks left on its " +
  "default configured selection, record the gate the publication boundary " +
  "requires. run_scripts never does, and a run_checks narrowed by groups or " +
  "explicit commands does not either.";

/**
 * Whether this node could mint a publication gate at all.
 *
 * CAPABILITY, not type. run_checks records a gate only on its default
 * configured path (blocks/run-checks.ts): a `groups` selection is refused
 * because a node that ran only `lint` never established what the gate claims,
 * and an explicit `commands` list produces no configuration version to record
 * against. A `skipReason` returns before any of it. Keying on the type alone
 * traded one falsehood ("no block can") for a narrower silence: the author of a
 * run_checks(groups: ["lint"]) graph would be told nothing at all.
 */
export function nodeCanRecordGate(node: {
  type: string;
  params: Record<string, unknown>;
}): boolean {
  if (node.type === "run_pre_pr_checks") return true;
  if (node.type !== "run_checks") return false;
  const narrowing = (value: unknown): boolean =>
    Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim());
  if (narrowing(node.params.groups) || narrowing(node.params.commands)) return false;
  return !(
    typeof node.params.skipReason === "string" && node.params.skipReason.trim()
  );
}

/**
 * Which class of failure the lead sentence announces.
 *
 * `outcome` decides "nothing ran", never the emptiness of `failures`. An
 * unreadable configuration reports outcome "failed" with no failure entries at
 * all (its summary names the broken field), and reading that as "nothing
 * matched" told an operator their selection was fine when the configuration
 * could not be parsed.
 */
function repositoryScriptFailureClass(
  scripts: RecoveredRepositoryScriptsFailure,
): string {
  const phases = scripts.failures.map((failure) => failure.phase);
  // An ordinary failing command leads, whatever else happened: it is the one
  // class an operator answers by reading the output below.
  if (phases.some((phase) => phase === null)) return REPOSITORY_SCRIPTS_FAILED_LEAD;
  if (phases.includes("budget")) return REPOSITORY_SCRIPTS_BUDGET_LEAD;
  // A stopped batch keeps whatever it managed to run, so "could not be
  // started" contradicts the commands rendered right under the sentence.
  if (phases.includes("batch")) return REPOSITORY_SCRIPTS_ABANDONED_LEAD;
  if (phases.length > 0) return REPOSITORY_SCRIPTS_NOT_STARTED_LEAD;
  return scripts.outcome === "skipped"
    ? REPOSITORY_SCRIPTS_NOTHING_RAN_LEAD
    : REPOSITORY_SCRIPTS_NOT_STARTED_LEAD;
}

function renderRepositoryScriptFailure(
  failure: RepositoryScriptsOutput["failures"][number],
): string {
  const heading = failure.phase
    ? REPOSITORY_SCRIPT_PHASE_HEADINGS[failure.phase]
    : undefined;
  const head = `${heading ? `${heading} ` : ""}${failure.repo}: ${failure.command} (exit ${failure.exitCode})`;
  return failure.output ? `${head}\n${failure.output}` : head;
}

/**
 * The failures to render, and how many ordinary ones were left out.
 *
 * Only ordinary command failures compete for the window. Everything with a
 * phase is a TERMINAL cause (the checks ceiling ran out, a toolchain never
 * installed, a batch lost its sandbox) and answers a different question from
 * the commands around it, so array order deciding whether an operator learns
 * that the budget was spent is not a bound, it is a coin toss: six failing
 * commands ahead of the budget entry hid the only line that named the real
 * reason nothing else ran.
 */
function selectRepositoryScriptFailures(
  failures: RepositoryScriptsOutput["failures"],
): { shown: RepositoryScriptsOutput["failures"]; omitted: number } {
  const ordinary = failures.filter((failure) => failure.phase === null);
  const kept = new Set(ordinary.slice(0, REPOSITORY_SCRIPT_FAILURES_SHOWN));
  return {
    shown: failures.filter((failure) => failure.phase !== null || kept.has(failure)),
    omitted: ordinary.length - kept.size,
  };
}

/**
 * What this run's scripts left in the trees, as one line per repository.
 *
 * Rendered here as well as in the gate's own message because that message is
 * an execution error detail, and every surface that carries one clamps it: the
 * ticket comment is the only place with room for the whole list. It is also the
 * only surface where the culprit and the agent's own uncommitted work can be
 * shown side by side without one of them being truncated away.
 */
function renderRepositoryScriptDrift(
  dirtied: RepositoryScriptsOutput["dirtied"],
): string[] {
  const lines = dirtied.flatMap((entry) => [
    ...(entry.files.length > 0
      ? [`Repository scripts modified in ${entry.repo}: ${entry.files.join(", ")}`]
      : []),
    ...(entry.preExisting.length > 0
      ? [`Already modified before the scripts ran in ${entry.repo}: ${entry.preExisting.join(", ")}`]
      : []),
  ]);
  return lines.length > 0 ? [lines.join("\n")] : [];
}

/**
 * The one ticket comment a failed run posts, with the script evidence attached.
 *
 * `reason` stays first and byte-for-byte: it is the string the run header, the
 * run list and the Slack notification all carry, and the four surfaces agreeing
 * on it is what AIW-254 bought. Everything below it is additional evidence this
 * one surface has room for, never a replacement, and never a second comment.
 */
export function repositoryScriptsFailureComment(
  reason: string,
  scripts: RecoveredRepositoryScriptsFailure | null,
  options: {
    repairCyclesRequested?: boolean;
    /** The run failed on a missing publication gate and the definition contains
     *  no block that could ever record one. */
    noGateBlock?: boolean;
    /** Drift recovered independently of a scripts FAILURE: a group with
     *  restoreTree false can leave files behind on a run whose scripts all
     *  passed, and that is exactly the run the publication boundary then
     *  refuses. */
    drift?: RepositoryScriptsOutput["dirtied"];
    /** Setup failures from the prepare phase. They fail the run before any
     *  scripts output exists, so nothing here can be recovered from the steps:
     *  without them the comment had only the bounded reason to show, and the
     *  elision that bounds it lands inside the command. */
    setupFailures?: RepositoryScriptsOutput["failures"];
  } = {},
): string {
  // The caller's drift wins when it has any: it is merged across every script
  // block the walk ran, while a recovered failure carries only the last one's.
  const drift = renderRepositoryScriptDrift(
    options.drift?.length ? options.drift : (scripts?.dirtied ?? []),
  );
  const notes = [
    ...(options.noGateBlock ? [NO_GATE_BLOCK_NOTE] : []),
    ...(options.repairCyclesRequested ? [REPAIR_CYCLES_REMOVED_NOTE] : []),
  ];
  const coverageNotes = repositoryScriptCoverageNotes(scripts?.groupCoverage ?? []);
  const coverage = coverageNotes.length > 0 ? [coverageNotes.join("\n")] : [];
  // Before the scripts, because setup runs before them: a repository whose
  // toolchain never installed ran no scripts at all.
  const setup = (options.setupFailures ?? []).map(renderRepositoryScriptFailure);
  if (!scripts) {
    return [reason, ...setup, ...drift, ...notes].join("\n\n");
  }
  const { shown, omitted } = selectRepositoryScriptFailures(scripts.failures);
  const sections = [
    reason,
    ...setup,
    [
      repositoryScriptFailureClass(scripts),
      // The engine's own sentence, but only when there is no failure entry to
      // render. It is the only thing that speaks for a run without one (an
      // unreadable configuration names the broken field here); next to the
      // rendered failures it is the same commands, exit codes and output tails
      // a second time, because that is what it was built from.
      ...(scripts.failures.length === 0 && scripts.summary ? [scripts.summary] : []),
      ...shown.map(renderRepositoryScriptFailure),
      ...(omitted > 0
        ? [
            `and ${omitted} more failing command${omitted === 1 ? "" : "s"} not shown. ` +
              REPOSITORY_SCRIPT_FAILURES_ELSEWHERE,
          ]
        : []),
    ].join("\n\n"),
    // After the failures, because they are two different facts about the same
    // run and an operator needs both: the command that failed where it ran, and
    // the repositories the selection never covered at all. The engine appends
    // the same sentences to a CLEAN run's summary, which is the run this
    // comment never posts for.
    ...coverage,
    ...drift,
    ...notes,
  ];
  return sections.join("\n\n");
}

/** True when any node of the executing definition still carries a positive
 *  maxFixCycles. Read from the definition rather than from the block output:
 *  the engine drops the parameter, so nothing downstream of it remembers that
 *  the author asked. */
export function definitionRequestsRepairCycles(
  nodes: ReadonlyArray<{ params: Record<string, unknown> }>,
): boolean {
  return nodes.some((node) => {
    const cycles = node.params.maxFixCycles;
    return typeof cycles === "number" && cycles > 0;
  });
}
export { checksBudgetObserver };
