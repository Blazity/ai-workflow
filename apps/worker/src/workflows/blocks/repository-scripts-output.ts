import type {
  RepoScriptsGroupCoverage,
  RepoScriptsGroupStatusEntry,
} from "../../pre-pr-checks/runner.js";

/**
 * The engine's own group-status entry, restated as an object type alias.
 *
 * Not a duplicate declaration: the mapped type copies every field from
 * RepoScriptsGroupStatusEntry, so adding a field there adds it here. The
 * restatement is needed because a block output must satisfy BlockOutput's
 * `[key: string]: JsonValue` index signature, and TypeScript grants an implicit
 * index signature to object type ALIASES only, never to an interface.
 */
export type RepositoryScriptGroupStatus = {
  [K in keyof RepoScriptsGroupStatusEntry]: RepoScriptsGroupStatusEntry[K];
};

/** As RepositoryScriptGroupStatus: a mapped copy of the engine's own entry, so
 *  the block output satisfies BlockOutput's index signature. */
export type RepositoryScriptGroupCoverage = {
  [K in keyof RepoScriptsGroupCoverage]: RepoScriptsGroupCoverage[K];
};

/**
 * Selected groups that ran nowhere they were asked to, as one number.
 *
 * Derived rather than carried, and in one place, so the count and the sentences
 * can never disagree about what an uncovered group is. Both key on a non-empty
 * `missing`: `skipped` is not a gap, because the runner left that repository
 * out of the run and the configuration says nothing about it either way.
 */
export function countUncoveredGroups(
  coverage: ReadonlyArray<Pick<RepositoryScriptGroupCoverage, "missing">>,
): number {
  return coverage.filter((entry) => entry.missing.length > 0).length;
}

/** Groups narrated before the rest are counted. Three sentences is what a run
 *  header, a Slack line and a ticket comment have room for; beyond that the
 *  groupCoverage field is where an operator reads the detail. */
const COVERAGE_NOTE_GROUP_CAP = 3;

/**
 * The sentences a partly covered selection adds, word for word, wherever it is
 * reported.
 *
 * Here rather than beside either surface because two of them have to agree: the
 * engine appends them to a clean run's summary, and the ticket comment appends
 * them under a failing one, so an operator reading either sees the same gap
 * described the same way.
 *
 * Empty coverage yields no sentences, which is what makes this safe to call
 * unconditionally: a gate selection and an explicit command list report no
 * coverage at all, so neither can be narrated a gap it never had.
 */
export function repositoryScriptCoverageNotes(
  coverage: ReadonlyArray<Pick<RepositoryScriptGroupCoverage, "group" | "missing">>,
): string[] {
  const gaps = coverage.filter((entry) => entry.missing.length > 0);
  const shown = gaps.slice(0, COVERAGE_NOTE_GROUP_CAP);
  const notes = shown.map(
    (entry) =>
      `Selected group "${entry.group}" is not declared by ${entry.missing.join(", ")}; ` +
      "it ran nothing there.",
  );
  const rest = gaps.length - shown.length;
  if (rest > 0) {
    notes.push(
      `And ${rest} more selected group${rest === 1 ? "" : "s"} ran nothing in at least ` +
        "one repository.",
    );
  }
  return notes;
}

export type RepositoryScriptResult = {
  repo: string;
  command: string;
  group: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
};

export type RepositoryScriptFailure = {
  repo: string;
  command: string;
  exitCode: number;
  output: string;
  phase: string | null;
};

export type RepositoryScriptDirtied = {
  repo: string;
  files: string[];
  preExisting: string[];
};

/**
 * The output fields both repository script blocks publish.
 *
 * Declared as a type alias rather than an interface on purpose: a block output
 * has to satisfy BlockOutput's `[key: string]: JsonValue` index signature, and
 * TypeScript only grants an implicit index signature to object type aliases.
 *
 * It lives here rather than beside the block that builds it because three
 * different readers recover it from a walk's durable steps, and a reader that
 * imported the workflow entry point would invert this package's one structural
 * rule: nothing under blocks/ imports agent.ts.
 */
export type RepositoryScriptsOutput = {
  ok: boolean;
  outcome: "passed" | "failed" | "skipped" | "missing_configuration";
  allPassed: boolean;
  anyFailed: boolean;
  groupStatuses: RepositoryScriptGroupStatus[];
  /** What each NAMED selected group did in each configured repository. The one
   *  field that survives the aggregates: `ok` and `allPassed` are true of the
   *  repositories that ran, and say nothing about the ones a selection never
   *  reached. Empty for a gate selection and for explicit commands, neither of
   *  which selects groups by name. */
  groupCoverage: RepositoryScriptGroupCoverage[];
  /** How many selected groups have a non-empty `missing`. The branchable form
   *  of groupCoverage: the branch language has no condition over arrays beyond
   *  has_value, so a definition that needs a group to run everywhere wires
   *  `uncoveredGroupCount equals 0` and branches on that. */
  uncoveredGroupCount: number;
  results: RepositoryScriptResult[];
  failures: RepositoryScriptFailure[];
  dirtied: RepositoryScriptDirtied[];
  setupFailed: boolean;
  summary: string;
};

/**
 * Recognise a repository scripts output among a walk's durable step outputs.
 *
 * By shape, never by node id: a definition names its nodes whatever it likes,
 * and both script blocks publish this same output. The check is the FULL field
 * set because the emitter writes every field on every path
 * (agent.ts repositoryScriptsOutput), so a partial match means the output came
 * from something else and reading it would attribute another block's data to
 * the scripts.
 *
 * One guard, deliberately. Three readers used to carry three hand-rolled
 * versions of this test, and they had already drifted apart: one required a
 * summary, one required `dirtied`, one required `failures`, so the same step
 * output was recognised by some readers and not others.
 *
 * `groupCoverage` and `uncoveredGroupCount` are the emitted fields deliberately
 * NOT required here. They were added after this shape shipped, so a run whose
 * scripts step was recorded by an earlier deployment carries every other field
 * and not those two, and requiring them would make those outputs unrecognizable
 * exactly when a run crosses a deploy. The one reader that touches coverage
 * (the failure comment) defaults it, which is why the recovered type declares
 * it optional.
 *
 * Not exhaustive over element types: it proves the containers exist and the
 * scalars have the right primitive types, and leaves the elements to the
 * emitter, which is the only writer. Widening it to walk every element would
 * make an oversized output cost a deep scan on a hot path for no reader that
 * could act on the difference.
 */
export function asRepositoryScriptsOutput(
  output: unknown,
): RepositoryScriptsOutput | null {
  if (!output || typeof output !== "object") return null;
  const candidate = output as Record<string, unknown>;
  if (typeof candidate.outcome !== "string") return null;
  if (typeof candidate.summary !== "string") return null;
  if (typeof candidate.ok !== "boolean") return null;
  if (typeof candidate.allPassed !== "boolean") return null;
  if (typeof candidate.anyFailed !== "boolean") return null;
  if (typeof candidate.setupFailed !== "boolean") return null;
  if (!Array.isArray(candidate.groupStatuses)) return null;
  if (!Array.isArray(candidate.results)) return null;
  if (!Array.isArray(candidate.failures)) return null;
  if (!Array.isArray(candidate.dirtied)) return null;
  return candidate as unknown as RepositoryScriptsOutput;
}

/**
 * The class sentences a repository scripts verdict is announced with.
 *
 * Here rather than beside any one surface, because four of them have to agree
 * word for word: the ticket comment leads with them, the publication boundary
 * refuses with them, the setup path names its own prefix, and runs.diagnose
 * classifies a run by MATCHING them. A classifier that re-typed the sentences
 * it matches is the failure this module already exists to prevent, and it rots
 * silently the day one of them is reworded.
 *
 * Stems, not finished sentences: the comment ends them with a full stop, the
 * boundary continues them into ", so publication was refused". One closed set,
 * so a class that exists on one surface cannot be missing from the other: the
 * budget stop led the comment with CHECKS BUDGET SPENT while the boundary
 * refused with "Repository scripts failed: (checks budget) (exit -1)".
 */
export const REPOSITORY_SCRIPTS_FAILED_CLASS = "Repository scripts failed";
export const REPOSITORY_SCRIPTS_ABANDONED_CLASS =
  "Repository scripts were stopped before finishing";
export const REPOSITORY_SCRIPTS_TIMED_OUT_CLASS = "Repository scripts timed out";
export const REPOSITORY_SCRIPTS_BUDGET_CLASS = "CHECKS BUDGET SPENT";
export const REPOSITORY_SCRIPTS_NOT_STARTED_CLASS =
  "Repository scripts could not be started";
export const REPOSITORY_SCRIPTS_NOTHING_RAN_CLASS =
  "0 commands executed - no entry matched the changed repositories";

/**
 * Opening of the run-level reason a failed repository setup records.
 *
 * runs.diagnose KEYS on this prefix (mcp/run-diagnosis.ts) to route a setup
 * failure to the repository-scripts category, so any other producer of a run
 * reason starting with these words would be classified as one. Setup
 * provisions the workspace before any agent runs, which is why it fails in a
 * different block from the scripts and needs an opening of its own.
 */
export const REPOSITORY_SCRIPTS_SETUP_FAILED_PREFIX = "Setup failed in ";

const REFUSED_SUFFIX = ", so publication was refused: ";

/** Every class a scripts refusal can open with. Exported as one list so the
 *  surfaces that ROUTE on the class (the finalize block's lead selection,
 *  runs.diagnose) never re-type a sentence this module composes. */
export const REPOSITORY_SCRIPTS_REFUSAL_LEADS: readonly string[] = [
  REPOSITORY_SCRIPTS_FAILED_CLASS,
  REPOSITORY_SCRIPTS_ABANDONED_CLASS,
  REPOSITORY_SCRIPTS_TIMED_OUT_CLASS,
  REPOSITORY_SCRIPTS_BUDGET_CLASS,
  REPOSITORY_SCRIPTS_NOT_STARTED_CLASS,
];

/** Whether a run-level reason is one of this module's refusals. It is already a
 *  finished, bounded lead, so a caller that wraps it in the generic checks
 *  category sentence would bury the command it names. */
export function isRepositoryScriptsRefusal(message: string): boolean {
  return REPOSITORY_SCRIPTS_REFUSAL_LEADS.some((lead) => message.startsWith(lead));
}

/**
 * What a phase-tagged entry says in place of an exit code.
 *
 * These entries are synthetic: the budget stop, the abandoned batch and the
 * unavailable workspace all record -1 because nothing ran to produce a status,
 * and "(exit -1)" reads as a command that ran and returned it.
 */
const REPOSITORY_SCRIPT_PHASE_DETAILS: Record<string, string> = {
  setup: "setup failed",
  workspace: "workspace unavailable",
  batch: "batch stopped",
  omitted: "failures omitted",
  env: "environment unavailable",
  budget: "checks budget spent",
};

/**
 * Longest refusal message this composes.
 *
 * SNIPPET_MAX_LENGTH in workflow-definition/failure-message.ts. The thrower
 * uses this string as its own detail, so derivation sees a snippet identical to
 * the lead and returns the lead alone; one character more and the message is
 * clamped into a different string and appended to itself in parentheses.
 */
const REFUSAL_MAX_LENGTH = 160;

/** Shortest command text worth printing before the repository is cut instead. */
const REFUSAL_MIN_COMMAND = 12;

/** `<repo>: <command> (<detail>)`, fitted into REFUSAL_MAX_LENGTH.
 *
 * The verdict at the end always survives: it is the part an operator cannot
 * reconstruct, and a trailing clamp is exactly what would eat it. The command
 * is trimmed first, then the repository path from the LEFT (its tail carries
 * the repository name), because a 90-character monorepo path would otherwise
 * spend the whole budget before the command started. */
function namedFailure(
  lead: string,
  repo: string,
  command: string,
  detail: string,
  omitted: number,
): string {
  const suffix = ` (${detail})${omitted > 0 ? `; and ${omitted} more` : ""}`;
  const fixed = `${lead}${REFUSED_SUFFIX}`.length + ": ".length + suffix.length;
  let room = REFUSAL_MAX_LENGTH - fixed;
  let shownRepo = repo;
  if (repo.length + REFUSAL_MIN_COMMAND > room) {
    const keep = Math.max(0, room - REFUSAL_MIN_COMMAND);
    shownRepo = keep < repo.length ? `...${repo.slice(repo.length - keep + 3)}` : repo;
  }
  room -= shownRepo.length;
  const shownCommand =
    command.length <= room ? command : `${command.slice(0, Math.max(0, room - 3))}...`;
  return `${lead}${REFUSED_SUFFIX}${shownRepo}: ${shownCommand}${suffix}`;
}

/** Identity of one command RUN: the same command text in two repositories is
 *  two different commands, and joining results to failures on the text alone
 *  reported repository B as timed out with repository A's duration. */
function runKey(repo: string, command: string): string {
  return `${repo}\u0000${command}`;
}

/**
 * Why publication was refused, when the refusal is the scripts' own verdict.
 *
 * The boundary refuses on a missing gate record, and a run whose scripts failed
 * has no gate record precisely BECAUSE they failed. Reporting the missing
 * record was answering a question nobody asked: the operator needs the command,
 * and the gate sentence never named one on any surface.
 *
 * The precedence is the ticket comment's (agent.ts repositoryScriptFailureClass)
 * and has to stay that way, because the two sentences land in the same comment:
 * an ordinary failing command first, then a timeout, then the budget, then an
 * abandoned batch, then anything that never started.
 *
 * Returns null when the output carries no failure to name, so the caller keeps
 * the sentence about the record itself, which is then the only true one.
 */
export function repositoryScriptsRefusalMessage(
  output: RepositoryScriptsOutput,
): string | null {
  const timedOutRuns = new Set(
    output.results
      .filter((result) => result.timedOut)
      .map((result) => runKey(result.repo, result.command)),
  );
  const commandFailures = output.failures.filter((failure) => failure.phase === null);
  const phased = (phase: string) =>
    output.failures.filter((failure) => failure.phase === phase);
  const buckets: ReadonlyArray<readonly [string, RepositoryScriptFailure[]]> = [
    [
      REPOSITORY_SCRIPTS_FAILED_CLASS,
      commandFailures.filter(
        (failure) => !timedOutRuns.has(runKey(failure.repo, failure.command)),
      ),
    ],
    [
      REPOSITORY_SCRIPTS_TIMED_OUT_CLASS,
      commandFailures.filter((failure) =>
        timedOutRuns.has(runKey(failure.repo, failure.command)),
      ),
    ],
    [REPOSITORY_SCRIPTS_BUDGET_CLASS, phased("budget")],
    [REPOSITORY_SCRIPTS_ABANDONED_CLASS, phased("batch")],
    [
      REPOSITORY_SCRIPTS_NOT_STARTED_CLASS,
      output.failures.filter(
        (failure) =>
          failure.phase !== null && failure.phase !== "budget" && failure.phase !== "batch",
      ),
    ],
  ];

  const hit = buckets.find(([, entries]) => entries.length > 0);
  if (!hit) return null;
  const [lead, entries] = hit;
  const first = entries[0]!;
  // Counted within the class that led, never across all of them: "; and 1 more"
  // pointing at a phase-tagged entry sends an operator looking for a second
  // failing command that does not exist.
  return namedFailure(lead, first.repo, first.command, failureDetail(output, first, lead), entries.length - 1);
}

function failureDetail(
  output: RepositoryScriptsOutput,
  failure: RepositoryScriptFailure,
  lead: string,
): string {
  if (lead === REPOSITORY_SCRIPTS_TIMED_OUT_CLASS) {
    const ran = output.results.find(
      (result) => runKey(result.repo, result.command) === runKey(failure.repo, failure.command),
    );
    const minutes = Math.max(1, Math.round((ran?.durationMs ?? 0) / 60_000));
    return `timed out after ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (failure.phase) {
    return REPOSITORY_SCRIPT_PHASE_DETAILS[failure.phase] ?? failure.phase;
  }
  // Negative exit codes are the engine's "no status was recorded" marker
  // (runner.ts BATCH_MISSING_EXIT_REASON), not something the command returned.
  return failure.exitCode >= 0 ? `exit ${failure.exitCode}` : "no exit status recorded";
}
