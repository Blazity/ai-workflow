/**
 * What this run decided before it did anything: its settings and the
 * repositories it may touch.
 *
 * A run is an entry point, exactly like an HTTP request or a cron tick, and it
 * obeys the same rule: read the deployment's decisions ONCE, then hand them
 * down synchronously. The reason a run needs its own rule is that it outlives
 * the read by hours. An operator who lowers a timeout or disables a repository
 * while a run is in flight must not move a run that already started, or the
 * same run would take one branch on its first execution and another on a
 * replay, and the Workflow journal would record a divergence nobody can
 * explain. `appliesToRunsInFlight: "next run"` in the settings registry is
 * this promise; this step is where it is kept.
 *
 * It is the ONLY place in the engine that reads either store. Everything below
 * it takes the values as parameters, so no step and no loop pays a database
 * read per element, and nothing reachable from the workflow isolate imports a
 * store at all.
 *
 * Why it reads the db repositories rather than `services/settings` and
 * `services/repository-catalog`: ADR-001 gives the engine no edge to a
 * service, and `scripts/gates/boundaries.mjs` enforces that with no baseline.
 * The rule each of those services applies lives in `@shared/contracts`
 * (`resolveSettingsSnapshot`, `runRepositoryEnabledKeys`), which every tier may
 * import, so this composes the same rule rather than a second copy of it. The
 * precedent for a step reading a db repository directly is
 * `loadPrePrCheckConfigStep` in `engine/blocks/pre-pr-checks.ts`.
 */
import {
  defaultSettingsSnapshot,
  resolveSettingsSnapshot,
  runRepositoryEnabledKeys,
  type RunRepositoryAccess,
  type SettingsSnapshot,
  type WorkScope,
} from "@shared/contracts";

/**
 * The record of which repositories this subject's work touches, as the run
 * froze it.
 *
 * `scope` is null when nothing was ever written for the subject, which is a
 * different fact from the field being absent: absent means no record was read
 * at all. `selectionAnswered` travels beside the entries because the answer it
 * reports records none: "none of these" to the which-of-these question writes
 * no entry by design, so without this flag the next run asks it again.
 */
export interface RunStartWorkScope {
  subjectKey: string;
  scope: WorkScope | null;
  selectionAnswered: boolean;
  /** The repositories a question on this subject named and somebody answered
   *  for, which is what "ask about a given repository once, then tell" is
   *  decided on. It is a second fact rather than a narrowing of
   *  `selectionAnswered`, because that flag is subject-wide: an answer about
   *  one repository must not silence the first question about another.
   *
   *  ABSENT MEANS NOTHING WAS ASKED YET, SO ASK. A run suspended across the
   *  deploy that added this field replays a result written without it, and the
   *  only safe reading of a missing set is the empty one: a person is asked
   *  once more, rather than told about a decision this run cannot see. */
  answeredRepositoryKeys?: string[];
  /** What the record made of the answer this run woke on: false only when it
   *  declined to attribute the words, which today means more than one person
   *  wrote them. Set by `readWorkScopeAfterAnswerStep`, so it is absent on every
   *  run that has not been answered yet and on one replaying a result written
   *  before the field existed.
   *
   *  ABSENT MEANS THE VERDICT IS UNKNOWN, NOT THAT THERE WAS NO REFUSAL. The one
   *  reader (`blocks/prepare-workspace/execute.ts`) says what it does with that,
   *  and it is not the same as either value. */
  answerAttributed?: boolean;
  /** Has a person already answered the narrowing question on this subject, the
   *  one that tells them how many repositories are in scope and asks which are
   *  essential? Its own fact rather than part of `selectionAnswered`, which is
   *  subject-wide and silences a different question.
   *
   *  ABSENT MEANS NOBODY HAS, SO ASK. A run replaying a result written before
   *  this field existed reads the same as a subject nobody narrowed, which is
   *  exactly the behaviour that run already had. */
  narrowingAnswered?: boolean;
}

/**
 * The run-start result, as the journal stores it.
 *
 * Every field below `settings` is optional and has a defined meaning when
 * absent, so a result written by another deployment of this step still parses
 * on resume. That is the `repositoryVersions` precedent in
 * `engine/blocks/pre-pr-checks.ts`, and it matters here for the same reason: a
 * run suspended across a deploy replays this step's STORED result, never a
 * fresh read. `settings` itself is not optional, because a stored result
 * without it is not a result of this step at all.
 */
export interface RunStartSettings {
  /** Shape version. Absent means 1, which is what this deployment writes. */
  version?: number;
  settings: SettingsSnapshot;
  /** Absent on a result stored before this field existed; absent means the
   *  bridge, where every repository the installation exposes is reachable,
   *  which is exactly what a deployment without a catalog did. */
  repositories?: RunRepositoryAccess;
  /** Absent on a result stored before this field existed, and on a run whose
   *  subject carries no record at all (a schedule occurrence, a delivery that
   *  resolved no subject). Absent means no record was read, which puts the run
   *  on the whole path it took before this field existed; there is no default
   *  that pretends one was. */
  workScope?: RunStartWorkScope;
}

/**
 * The deployment's settings and enabled repositories, read once at run start.
 *
 * Idempotent under retry: two reads with nothing written between them give the
 * same answer, and the step writes nothing at all. A retry that straddles an
 * operator's save returns the later value, which is the same window every
 * entry point has and is why the read happens once rather than per block.
 */
export async function loadRunStartSettingsStep(input: {
  /** The subject whose work scope this run freezes, or null for a run that
   *  carries none. The CALLER decides with `carriesWorkScope`
   *  (`engine/work-scope/subject.ts`), because whether a webhook delivery
   *  resolved a subject of its own is read off the entry, not off this step. */
  workScopeSubjectKey: string | null;
}): Promise<RunStartSettings> {
  "use step";
  const { readAllConnectedSettings } = await import("../../db/repositories/settings.js");
  const {
    getConnectedRepositoryCatalogStateRow,
    listConnectedRepositoryCatalogKeys,
  } = await import("../../db/repositories/repository-catalog.js");
  const {
    readConnectedWorkScope,
    readConnectedWorkScopeAnsweredRepositories,
    readConnectedWorkScopeNarrowingAnswered,
    readConnectedWorkScopeSelectionAnswered,
  } = await import("../../db/repositories/work-scope.js");
  const { settingsEnvironment } = await import("../../infra/settings-environment.js");
  const { logger } = await import("../../infra/logger.js");

  const subjectKey = input.workScopeSubjectKey;
  const [
    rows,
    stateRow,
    keys,
    scope,
    selectionAnswered,
    answeredRepositoryKeys,
    narrowingAnswered,
  ] = await Promise.all([
    readAllConnectedSettings(),
    getConnectedRepositoryCatalogStateRow(),
    listConnectedRepositoryCatalogKeys(),
    // Beside the other two rather than after them: they are all pure reads of
    // this deployment's state, and a run start pays one round trip for them.
    subjectKey === null ? Promise.resolve(null) : readConnectedWorkScope(subjectKey),
    subjectKey === null
      ? Promise.resolve(false)
      : readConnectedWorkScopeSelectionAnswered(subjectKey),
    subjectKey === null
      ? Promise.resolve<string[]>([])
      : readConnectedWorkScopeAnsweredRepositories(subjectKey),
    subjectKey === null
      ? Promise.resolve(false)
      : readConnectedWorkScopeNarrowingAnswered(subjectKey),
  ]);
  const { snapshot } = resolveSettingsSnapshot(
    new Map(rows.map((row) => [row.key, row.value])),
    settingsEnvironment,
  );
  const repositories: RunRepositoryAccess = {
    activated: stateRow.activated,
    enabledKeys: runRepositoryEnabledKeys(keys),
  };
  logger.info(
    {
      storedSettings: rows.length,
      catalogActivated: repositories.activated,
      // The keys themselves, not just how many. "enabled 4 repositories" is
      // unfalsifiable: the question an operator asks of this line is always
      // "was THIS repository in the list when the run started", and a count
      // cannot answer it. The list is bounded by what an installation enables
      // and holds no secret (`provider:owner/name`).
      enabledRepositories: repositories.enabledKeys,
      enabledRepositoryCount: repositories.enabledKeys.length,
    },
    "run_start_settings",
  );
  return {
    version: 1,
    settings: snapshot,
    repositories,
    ...(subjectKey === null
      ? {}
      : {
          workScope: {
            subjectKey,
            scope,
            selectionAnswered,
            answeredRepositoryKeys,
            narrowingAnswered,
          },
        }),
  };
}
// A pure read with no write to undo, so a transient database error is worth
// retrying rather than failing a run that has not started yet.
loadRunStartSettingsStep.maxRetries = 3;

/**
 * The settings a stored run-start result means.
 *
 * Defaults first, the stored snapshot over them. A run suspended across a
 * deploy replays this step's STORED result, so a deployment that adds a
 * registry key resumes runs whose snapshot predates it; reading that key raw
 * would hand the run `undefined` where it expects a number or a string, and the
 * failure would land somewhere far from here. The registry default is what a
 * deployment without a stored row would have used anyway, which makes it the
 * only honest filler. The environment is deliberately NOT consulted: a resumed
 * run must not pick up a value the deployment changed under it, which is the
 * whole point of freezing the snapshot.
 *
 * Pure, so the workflow body may call it.
 */
export function runStartSettings(stored: RunStartSettings): SettingsSnapshot {
  return { ...defaultSettingsSnapshot(), ...stored.settings };
}

/**
 * The repository access a stored run-start result means.
 *
 * Pure, so the workflow body may call it: `undefined` is the bridge, which is
 * what a deployment whose result predates the field behaved as.
 */
export function runStartRepositoryAccess(
  stored: RunStartSettings,
): RunRepositoryAccess {
  return stored.repositories ?? { activated: false, enabledKeys: [] };
}

/**
 * The work scope a stored run-start result means, or null when it read none.
 *
 * Null is the whole old path: a run suspended across the deploy that added the
 * field replays a result written without it, and every decision below must go
 * on behaving exactly as it did, clarification re-read included. There is no
 * half-new path and no empty record standing in for one that was never read,
 * which is why this returns null rather than an empty scope.
 *
 * Pure, so the workflow body may call it, and it is the one way a caller takes
 * the value: nothing below reads `stored.workScope` directly.
 */
export function runStartWorkScope(stored: RunStartSettings): RunStartWorkScope | null {
  return stored.workScope ?? null;
}

/**
 * What the ticket is told when the catalog enables nothing.
 *
 * A ticket trigger is NOT one of the four paths the catalog decides dispatch
 * on, so a ticket moved into the AI column starts a run whatever the catalog
 * says. Until stage F that run prepared a workspace before finding out, and the
 * refusal arrived after the deployment had paid for it. The fix is the same
 * frozen list this step already reads, applied once the deployed graph is known
 * to need a repository, and the sentence names the switch because that is the
 * operator's next action.
 *
 * The sentence IS the record: it is written to the run's status reason and
 * posted as the ticket comment, and there is no separate failure-kind column
 * behind it to group by.
 */
export const NO_ENABLED_REPOSITORY_MESSAGE =
  "No repository is enabled in the catalog. Enable one on the Repositories page and move the ticket again.";

/**
 * Should this run stop before it does anything?
 *
 * True only when the catalog DECIDES access (an unactivated catalog is the
 * bridge, where the agent sees everything the installation exposes) and enables
 * nothing at all. A repository that is merely not enabled is a different
 * question, answered per repository inside the run, where the name is known.
 *
 * Pure, so the workflow body may call it, and read off the frozen result rather
 * than off the store: a run refuses on the list it started with, exactly as
 * every other repository decision in the run does.
 */
export function runStartHasNoEnabledRepository(stored: RunStartSettings): boolean {
  const access = runStartRepositoryAccess(stored);
  return access.activated && access.enabledKeys.length === 0;
}
