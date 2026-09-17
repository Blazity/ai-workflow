import type {
  RepositoryKey,
  TriggerRepositoryPolicy,
  WorkScope,
  WorkScopeActor,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import {
  filterPinnedRepositories,
  pinnedScopeExcludesProvider,
  type RepositoryListingFailure,
  type RepositoryMetadata,
  type SelectedRepository,
  type WorkflowOwnedBranch,
} from "../../../adapters/vcs/repository-directory.js";
import type {
  PreSandboxConfigStep,
  PreSandboxPromptAddition,
  PreSandboxRepositoryCatalogDegradation,
  PreSandboxRepositoryScopeNarrowing,
  PreSandboxStepContext,
  PreSandboxStepHandler,
  PreSandboxStepResult,
} from "../types.js";
import {
  createRunWorkScopeRecorder,
  KEPT_REPOSITORIES_SENTENCE_OPENING,
  TEXT_AMBIGUITY_QUESTION_OPENING,
  TEXT_MATCH_AMBIGUITY_LIMIT,
  workScopeRepositoryKey,
  type RunWorkScopeRecorder,
  type TicketTextReading,
} from "../../work-scope/context.js";
import { commentSaysNoAboutItsPaths } from "../../work-scope/answer.js";
import {
  addRepositoryDiscoveryRelationships,
  buildRepositoryCatalog,
  buildRepositoryCatalogEntries,
  type RepositoryCatalogEntry,
  type RepositoryRelationshipSource,
} from "../../repository-discovery/catalog.js";
// Pure token parser, no adapters behind it: runner.js imports only types plus
// catalog.js, which this module already pulls in.
import {
  parseRepositoryExpansionAnswer,
  type ParsedRepositoryIdentity,
} from "../../repository-discovery/runner.js";
import {
  filterRunRepositories,
  mayRunTouchRepository,
  NO_ENABLED_REPOSITORIES_MESSAGE,
  repositoryNotEnabledMessage,
} from "../../support/repository-access.js";
// Type only, so importing this file never pulls the routing module in with it.
//
// This file is NOT in the workflow isolate: the bundles were built and checked, and
// repoSelectionStep lands in the steps bundle, never in the workflows one. It is
// reached through a dynamic import inside a step body and runs in Node, which is why
// the isolate's no-Node-builtins rule does not apply here. The values below are
// still imported lazily, for the reason that does apply: importing this module must
// not drag the VCS adapters, the database client and the store in behind it on a
// path that only needs the pure selection function. The access predicate above is
// pure and imports nothing but the contracts package, so it stays static.
import type { RepoRoutingEntry } from "../../../memory/repo-routing.js";

export interface WorkflowOwnedBranchSelectionInput {
  provider: RepositoryMetadata["provider"];
  repoPath: string;
  branch: WorkflowOwnedBranch;
}

/**
 * The selection, and the work scope decisions it made on the way.
 *
 * The recorder travels in a box rather than in the return value because the
 * selection below returns from eight places and the caller needs the recorder
 * from every one of them, including the ones that halt. Absent means this run
 * read no record, which is the whole path this file took before the record
 * existed.
 */
interface WorkScopeCarrier {
  recorder: RunWorkScopeRecorder | null;
}

/**
 * Repository selection, and the one place the work scope of this subject is
 * written.
 *
 * The write rides THIS step, `blockPrepareWorkspacePreSandboxStep`
 * (`engine/blocks/prepare-workspace/execute.ts`, `maxRetries = 0`), through the
 * equally retry-free `runPreSandboxPhase`. It may not ride workflow scope:
 * a replay of a parked run re-runs workflow scope and would append the trail a
 * second time.
 */
export const repoSelectionStep: PreSandboxStepHandler = async (stepInput) => {
  const carrier: WorkScopeCarrier = { recorder: null };
  const result = await selectRepositoriesForRun(stepInput, carrier);
  return recordWorkScopeDecisions(result, carrier.recorder);
};

/**
 * Apply what the selection decided, then say what it left out.
 *
 * The write goes through the connected wrapper, never through the database
 * client: the engine holds no handle, and it reaches a store exactly as the run
 * start reaches settings and the catalog.
 *
 * A FAILED WRITE IS LOGGED AND THE RUN CONTINUES, and that is deliberately the
 * opposite of the answer path, which must not swallow one. The difference is
 * what the write is a copy of. Here it summarises what this run computed from
 * inputs that all still exist: the same ticket, the same policy, the same
 * catalog. The next run computes the same thing again, so a lost write costs a
 * debugging line and at worst one recomputation. There, the write was the ONLY
 * copy of a living person's decision, which nobody will enter a second time
 * because the question is closed; swallowing that is precisely the failure the
 * record exists to end. The log line carries the subject and the run so it can
 * be found rather than merely counted.
 */
async function recordWorkScopeDecisions(
  result: PreSandboxStepResult,
  recorder: RunWorkScopeRecorder | null,
): Promise<PreSandboxStepResult> {
  if (!recorder) return result;
  const runId = recorder.runId;
  if (runId !== null && recorder.plans.length > 0) {
    const { applyRunWorkScopePlans } = await import("../../work-scope/apply-plans.js");
    await applyRunWorkScopePlans({ subjectKey: recorder.subjectKey, runId, plans: recorder.plans });
  }
  return withWorkScopeOutcome(result, recorder);
}

/** The ask a question carried, and the sentences saying what the run left out,
 *  folded into whatever text this result already shows a person. */
function withWorkScopeOutcome(
  result: PreSandboxStepResult,
  recorder: RunWorkScopeRecorder,
): PreSandboxStepResult {
  const ask =
    recorder.ask.length > 0
      ? {
          workScopeAsk: {
            subjectKey: recorder.subjectKey,
            askedRepositories: recorder.ask,
          },
        }
      : {};
  /**
   * The same refusals a third time, keyed, on their way to the comment a
   * finished run posts.
   *
   * Everything below reaches a person only when the run STOPS, and the case
   * this exists for is the run that does not: a ticket covering two
   * repositories, one of them excluded weeks ago, the other attached, a green
   * run and a pull request covering half the work. The agent was told; the
   * person was not, and nobody goes looking for a problem a green run did not
   * report.
   *
   * Two fields rather than one, because they have different readers. The
   * refusals are facts about this run's workspace, so the agent may see them and
   * does, in the prompt addition below. The recovery sentence tells a human they
   * can change their mind, and it rides this field to the ticket comment and
   * nowhere else. Carried on every exit, exactly as the ask above is: the halt
   * paths simply never reach a report.
   */
  const carried = {
    ...(recorder.leftOut.length > 0 ? { workScopeLeftOut: [...recorder.leftOut] } : {}),
    ...(recorder.recoveryNotes.length > 0
      ? { workScopeRecoveryNotes: [...recorder.recoveryNotes] }
      : {}),
    // The scan itself, for the steps that speak after this one. Discovery and
    // the expansion loop offer the same way back, and without the ticket's own
    // matches they would have to guess whether a comment reaches the next run.
    ...(recorder.ticketText ? { workScopeTicketText: recorder.ticketText } : {}),
  };
  /*
   * TWO STRINGS, AND A QUESTION MAY ONLY EVER CARRY THE FIRST.
   *
   * `refusals` is what the run left out. It is a fact about this run's
   * workspace, the agent needs it, and it goes everywhere: the halt message,
   * the questions, the prompt addition.
   *
   * `recovery` names a lever meant for a person, editing this work's
   * repository list through the work scope API or the `work_scope.edit` tool. It
   * rides `message` and `cause`, which reach the run's status reason and the
   * ticket comment, and it must never reach a QUESTION, because a question is
   * not a message to a person that the agent happens not to read. A question
   * becomes a clarification round, and a clarification round is rendered
   * verbatim into the research, implementation and review prompts
   * (`sandbox/context.ts`) AND written into `ai-workflow/memory/<TICKET>.md`
   * under a heading reading "Human decisions (from the dashboard)" and "Do not
   * edit or remove" (`engine/support/human-decisions-memory.ts`). So a sentence
   * put in front of a person here arrives in the agent's durable memory
   * attributed to a human, which is worse than handing it to the prompt: the
   * prompt is this run's instructions, and the memory is every later run's
   * evidence about what people decided.
   *
   * What we do NOT claim: the sentence still reaches a later run as ordinary
   * ticket history, because this run posts it to the ticket and a later run
   * reads the ticket. That cannot be prevented without hiding the ticket, and a
   * comment a person could have typed by hand is not ours to retract. Read as
   * history it arrives attributed and dated, one comment among many. It is the
   * two channels we control, instructions and human-decision memory, that stay
   * clear of it.
   */
  const refusals = recorder.notes.join(" ");
  const recovery = [...recorder.notes, ...recorder.recoveryNotes].join(" ");
  if (recovery.length === 0) return { ...result, ...ask, ...carried };
  if (result.status === "halt") {
    // The halt message is the run's status reason and the ticket comment, so a
    // repository the run refused is named exactly where a person is already
    // reading about the run stopping.
    //
    // Unless the halt is a QUESTION, and then the message is not what anyone
    // sees: the block renders the questions and falls back to the message only
    // when there are none. So the REFUSALS ride the first question as well,
    // ahead of it, because "which of these should this ticket work on" reads as
    // a complete list to someone who was never told what the run had to leave
    // out.
    //
    // The refusals only. The two fields carry different text on purpose, and the
    // difference is the whole of the paragraph above: a message is read by a
    // person, and a question is read by a person and then kept forever as the
    // agent's record of what people decided.
    const asked = result.outcome === "needs_clarification" ? (result.questions ?? []) : [];
    return {
      ...result,
      ...ask,
      ...carried,
      ...(asked.length > 0 && refusals.length > 0
        ? {
            questions: asked.map((question, index) =>
              index === 0 ? `${refusals} ${question}` : question,
            ),
          }
        : {}),
      message: `${result.message} ${recovery}`,
      ...(result.cause ? { cause: `${result.cause} ${recovery}` } : {}),
    };
  }
  const addition: PreSandboxPromptAddition = {
    target: ["research", "implementation", "review"],
    title: "Repositories left out",
    content: recorder.notes.map((note) => `- ${note}`).join("\n"),
  };
  return {
    ...result,
    ...ask,
    ...carried,
    promptAdditions: [...(result.promptAdditions ?? []), addition],
  };
}

/**
 * The record as this run must read it, or null when it read none.
 *
 * A resumed run re-reads. Its frozen copy predates the answer that woke it, and
 * the answer was decided and recorded the moment it ARRIVED, so the record is
 * the whole of what it meant: the entries it wrote, whether the selection
 * question is now settled, and which repositories that question named. The
 * last one is not optional: an omission from a which-of-these answer writes no
 * entry, so a run that re-read the entries without it would see "nothing
 * decided" and let a guess take back what the person just left out
 * (`isUnnamedInAnswer`). One read of the whole picture rather than two named
 * ones, so a fact added to it reaches this run too. The re-read also sees a
 * panel edit made in between, which is the fresher truth rather than a staler
 * one.
 */
async function readRunWorkScope(
  context: PreSandboxStepContext,
): Promise<RunWorkScopeSelectionInput | null> {
  const frozen = context.workScope;
  const policy = context.workScopePolicy;
  const actor = context.workScopeActor;
  // All three or none. A record with no policy would have to be decided against
  // "no candidates", which starts a run with no repositories and reads like a
  // decision somebody made; an entry with no actor could not name its author.
  if (!frozen || !policy || !actor) return null;
  let scope: WorkScope | null = frozen.scope;
  let selectionAnswered = frozen.selectionAnswered;
  // The frozen copy, used as it stands only when the run froze one: a context
  // written before this field existed re-reads below rather than reading its
  // absence as "nothing was asked".
  let answeredRepositoryKeys: string[] = frozen.answeredRepositoryKeys ?? [];
  // Read beside the answered set and never apart from it: per repository, it
  // says from when the ticket's words about it are newer than the answer that
  // named it, and a copy of one older than the other would date a comment
  // against the wrong answer. Absent on a freeze written before it existed,
  // which dates nothing.
  let answeredAtByKey: Record<string, string> | undefined = frozen.answeredAtByKey;
  // TWO REASONS TO GO BACK TO THE STORE, AND THE SECOND IS A DEPLOY.
  //
  // A resumed run re-reads because its copy predates the answer. A run that
  // froze its context BEFORE this field existed re-reads because its copy of the
  // answered set is not empty but missing, and those are different facts: empty
  // says nobody was asked, missing says this run cannot tell. Guessing on
  // "missing" is what hands a repository somebody declined to the first signal
  // that names it, on the one run nobody can see the difference on. The read is
  // one query against a record the run already carries, and it brings back the
  // scope, the answered set and the answer's instant together, so this run never
  // holds half a pair.
  //
  // ONE OWNER FOR EACH "ABSENT". This decides what a missing field on the
  // RUN-START freeze means, and it is the only place that does. What a missing
  // field on a RESUME result means belongs to `applyHumanRepositoryExpansion`
  // (`engine/steps/phase.ts`), which installs the pair in full or leaves the
  // frozen copy alone. The two never fight: by the time a resume result is
  // read, this step has already given the run a pair that came from one read.
  //
  // NO NEW STEP CALL. This runs inside the pre-sandbox step body that already
  // reads the store on the clarification path, so a run suspended across the
  // deploy replays that step's recorded result and never executes it, and the
  // journal of a suspended run is unchanged.
  if (context.clarification || frozen.answeredRepositoryKeys === undefined) {
    const { readConnectedWorkScopeFacts } = await import(
      "../../../db/repositories/work-scope.js"
    );
    ({ scope, selectionAnswered, answeredRepositoryKeys, answeredAtByKey } =
      await readConnectedWorkScopeFacts(frozen.subjectKey));
  }
  return {
    subjectKey: frozen.subjectKey,
    scope,
    selectionAnswered,
    answeredRepositoryKeys,
    postAnswer: postAnswerComments(context.ticket, answeredAtByKey, context.botAccountId),
    catalogActivated: context.repositoryAccess.activated,
    policy,
    actor,
    // Read here, in a step, so the decision itself never touches a clock: a
    // replay replays this step's stored result and never reads the time again.
    now: new Date().toISOString(),
  };
}

const selectRepositoriesForRun = async (
  { context, step }: Parameters<PreSandboxStepHandler>[0],
  carrier: WorkScopeCarrier,
): Promise<PreSandboxStepResult> => {
  // A repository named by the definition is a repository this run is ASKED to
  // touch, so a pin the catalog withholds is refused here, by name, before the
  // provider listing and long before a sandbox. What happened instead was worse
  // than a late failure: the pin narrowed the listing to nothing and the run
  // parked on "Repositories pinned to this workflow are unavailable ... Restore
  // access", which is false (the provider is fine, the catalog said no) and
  // parks a run that then holds a dispatch claim while a human looks for an
  // outage that never happened.
  //
  // A halt rather than a throw, for two reasons. A throw is wrapped in
  // step-naming prose and is subject to the step's `onFailure`, which an
  // operator may set to `continue`; an authorization refusal must not be
  // continuable. And the refusal deliberately does NOT depend on the listing,
  // so it reads the same whether or not the provider is reachable.
  //
  // A pin the PROVIDER cannot reach is a different question and keeps its
  // clarification below: that one really can be restored without touching the
  // catalog.
  const pinnedOutsideCatalog = (context.repositoryScope?.repositories ?? []).find(
    (pinned) => !mayRunTouchRepository(context.repositoryAccess, pinned),
  );
  if (pinnedOutsideCatalog) {
    const refusal = repositoryNotEnabledMessage("prepare", pinnedOutsideCatalog);
    return { status: "halt", outcome: "failed", message: refusal, cause: refusal };
  }
  const { listRepositoriesAcrossProviders } = await import("../../../adapters/vcs/repository-directory.js");
  const { listConnectedWorkflowOwnedBranchesForTicket } = await import(
    "../../../db/repositories/runs.js"
  );
  const { getConfiguredVcsProviders } = await import("../../../infra/vcs-config.js");
  const ticketIdentifier = context.ticket.identifier;
  const workflowOwnedBranches = ticketIdentifier
    ? (await listConnectedWorkflowOwnedBranchesForTicket(ticketIdentifier)).map((record) => ({
        provider: record.provider,
        repoPath: record.repoPath,
        branch: {
          branchName: record.branchName,
          ...(record.pr ? { pr: record.pr } : {}),
        },
      }))
    : [];
  const repositoryScope = context.repositoryScope;
  const listing = await listRepositoriesAcrossProviders(
    listedVcsProviders(
      getConfiguredVcsProviders(),
      repositoryScope,
      workflowOwnedBranches,
    ),
  );
  const repositories = filterRunRepositories(
    context.repositoryAccess,
    listing.repositories,
  );
  // The catalog is on and everything the providers offered was dropped by it.
  // Discovery below would be handed an empty catalog and would ask a human
  // which repository to use, a question whose only honest answer is "none of
  // them", so the run is stopped here with the sentence that names the fix.
  // Only when the listing itself was not empty: a provider that returned
  // nothing is an infrastructure question, and the listing-failure paths below
  // already have the right words for it.
  if (
    context.repositoryAccess.activated &&
    repositories.length === 0 &&
    listing.repositories.length > 0
  ) {
    return {
      status: "halt",
      outcome: "failed",
      message: NO_ENABLED_REPOSITORIES_MESSAGE,
      cause: NO_ENABLED_REPOSITORIES_MESSAGE,
    };
  }
  const incompleteCatalogProviders = listing.failures
    .filter(
      (failure) =>
        !failedProviderCannotAffectSelection(
          failure.provider,
          repositoryScope,
          workflowOwnedBranches,
        ),
    )
    .map((failure) => failure.provider);

  // The answer as an ANSWER, from the field that says it is one. It used to be
  // read back out of a synthetic ticket comment, which meant the path scanner
  // saw it too and could take a repository out of a reply that refused it.
  const directAnswer =
    context.clarification?.resolves === "repository_selection"
      ? context.clarification.answer
      : null;
  const workScope = await readRunWorkScope(context);
  const scan = ticketTextScan(context.ticket, context.botAccountId);
  const selected = selectRepositoriesFromMetadata({
    ticketText: scan.own,
    ...(scan.comments ? { commentText: scan.comments } : {}),
    ...(scan.unread ? { unreadCommentText: scan.unread } : {}),
    repositories,
    workflowOwnedBranches,
    ...(repositoryScope ? { repositoryScope } : {}),
    ...(incompleteCatalogProviders.length > 0 ? { incompleteCatalogProviders } : {}),
    ...(directAnswer ? { directAnswer } : {}),
    ...(workScope ? { workScope } : {}),
  });
  carrier.recorder = selected.workScope ?? null;
  const narrowing = scopeNarrowing(repositories, repositoryScope);
  const degradation = catalogDegradation(
    listing.failures,
    selected.status === "catalog_incomplete",
  );
  /** The "continue with a selection" result, in one place because two paths now
   *  reach it: the deterministic selection below, and a remembered routing answer
   *  standing in for the question the discovery fallback would have asked. */
  const selectionResult = (chosen: SelectedRepository[]): PreSandboxStepResult => ({
    status: "continue",
    selectedRepositories: chosen,
    promptAdditions: [
      {
        target: ["research", "implementation", "review"],
        title: "Selected Repositories",
        content: chosen
          .map((repo) => `- ${repo.provider}:${repo.repoPath}: ${repo.selectedRationale}`)
          .join("\n"),
      },
    ],
    ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
    ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
  });

  if (selected.status === "catalog_incomplete") {
    const incomplete = incompleteCatalogMessage(
      step,
      listing.failures,
      selected.providers,
    );
    return {
      status: "halt",
      outcome: "failed",
      message: incomplete.message,
      ...(incomplete.cause ? { cause: incomplete.cause } : {}),
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  if (selected.status === "clarification_needed") {
    return {
      status: "halt",
      outcome: "needs_clarification",
      message: selected.questions[0],
      questions: selected.questions,
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  if (selected.status === "discovery_needed") {
    // The ONLY place remembered routing is consulted: `rememberedRoutingSelection`
    // has no other caller, and selectRepositoriesFromMetadata takes no routing
    // input. What that function does see is the record, where an earlier
    // remembered answer sits as an `inferred` entry, and run start never
    // attaches one (`decideRunStart` in `work-scope/decide.ts`), so memory cannot
    // reach a later run through the record either.
    //
    // WHAT REACHING THIS BRANCH PROVES: nothing was selected. `discovery_needed`
    // is that function's last return, and every signal that put a repository in
    // its selection returns first (the record's entries, a workflow-owned branch
    // whose repository was listed, a ticket text match the record allowed, the
    // only-accessible shortcut), as do a repository pin and an incomplete
    // catalog whatever they find. So mandatoryRepositories is empty here, and
    // the selection below drops nothing already chosen.
    //
    // WHAT IT DOES NOT PROVE: that no signal fired. A provider-only pin does not
    // return (it bounds `selected.catalog` instead), and a workflow-owned branch
    // whose repository was not listed, text matches the record refused, a
    // which-of-these question an earlier answer silenced, an only-accessible
    // repository the record refused, and (on a run with no record) a prior
    // answer naming several repositories all arrive here having selected nothing.
    // That is why the remembered repository is decided through the record below,
    // under the same exclusions, pin and policy as any derived key, and under
    // the answer: a repository a which-of-these question listed and the answer
    // left unnamed is not taken back by a guess (`isUnnamedInAnswer`).
    const remembered = routingMemoryEnabled(context.settings)
      ? await rememberedRoutingSelection(context.ticket.labels ?? [], selected.catalog)
      : null;
    if (remembered) {
      // A remembered routing answer is a guess learned across tickets, so it is
      // recorded as `inferred`, the lowest origin: anything the ticket, a
      // branch or a person says overwrites it on the next run. A record that
      // refuses it leaves the run on the discovery path below rather than
      // attaching a repository the record already decided against.
      const recorder = carrier.recorder;
      const attached =
        recorder === null ||
        recorder.decide({
          kind: "derived",
          origin: "inferred",
          repositoryKeys: [workScopeRepositoryKey(remembered)],
          rationale: ROUTING_MEMORY_RATIONALE,
        }).attach.length > 0;
      if (attached) return selectionResult([remembered]);
    }
    let relationshipSources: RepositoryRelationshipSource[] = [];
    try {
      const { listConnectedRepositoryRules } = await import(
        "../../../db/repositories/repository-catalog.js"
      );
      relationshipSources = await listConnectedRepositoryRules(
        context.repositoryAccess.enabledKeys,
      );
    } catch (error) {
      const { logger } = await import("../../../infra/logger.js");
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "repository_discovery_relationships_unreadable",
      );
    }
    const catalog = addRepositoryDiscoveryRelationships({
      catalog: selected.catalog,
      sources: relationshipSources,
      attachedKeys: selected.mandatoryRepositories.map(repositoryKey),
      enabledKeys: context.repositoryAccess.enabledKeys,
    });
    return {
      status: "continue",
      repositoryDiscovery: {
        catalog,
        mandatoryRepositories: selected.mandatoryRepositories,
      },
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  if (routingMemoryEnabled(context.settings)) {
    await rememberRoutingAnswer({
      labels: context.ticket.labels ?? [],
      ...(context.clarification ? { clarification: context.clarification } : {}),
      ticketIdentifier: context.ticket.identifier,
      branchName: context.run.branchName,
      repositories: selected.repositories,
    });
  }

  return selectionResult(selected.repositories);
};

/**
 * Both switches, on the read and on the write alike. ENABLE_REPO_MEMORY is the
 * feature-wide kill switch; ENABLE_REPO_ROUTING_MEMORY exists because a routing
 * document is org scoped and therefore carries across repository boundaries, which
 * on a forge where one top-level namespace holds several tenants is a tenancy
 * decision an operator has to make on its own. Gating on ENABLE_REPO_MEMORY alone
 * would have handed an org-scoped document to an operator who deliberately left
 * the org switches off.
 */
function routingMemoryEnabled(settings: {
  ENABLE_REPO_MEMORY: boolean;
  ENABLE_REPO_ROUTING_MEMORY: boolean;
}): boolean {
  return settings.ENABLE_REPO_MEMORY && settings.ENABLE_REPO_ROUTING_MEMORY;
}

/**
 * Per organisation document. Far more answers than a real organisation
 * accumulates: at MAX_ROUTING_LABEL_CHARS plus two corroborating ticket keys a
 * rendered line is around 250 ASCII bytes, so 50 entries come to roughly 12.5 KiB
 * and the entry count is what binds a mature document. The byte cap below is the
 * backstop for labels that are not ASCII, where the merge evicts whole entries
 * rather than truncating one.
 */
const MAX_ROUTING_ENTRIES = 50;
/** Per organisation document, sized above what MAX_ROUTING_ENTRIES can render so
 *  the entry count is the binding cap. Nothing injects a routing document into a
 *  prompt, so this bounds storage rather than tokens, which is why it is larger
 *  than the facts and lessons write cap. */
const MAX_ROUTING_DOC_BYTES = 24 * 1024;
/** Per run. One ticket cannot flood an organisation's document however many
 *  labels it happens to carry. */
const MAX_ROUTING_ENTRIES_PER_RUN = 5;
/** Compare-and-swap rounds. neon-http has no transactions, so the version
 *  predicate is what makes the read-merge-write safe; a document under contention
 *  from more writers than this keeps its winner and loses only this run's update. */
const MAX_ROUTING_WRITE_ATTEMPTS = 3;
/** Organisation documents read on the discovery fallback, bounding the round trips
 *  a run adds before the model or the human is asked. A catalog spanning more
 *  owners than this loses the tail, which costs a question and never a wrong
 *  repository. */
const MAX_ROUTING_OWNERS_READ = 5;

/**
 * The repository a ticket's labels remember, or null for "ask". Best effort in the
 * strongest sense: this runs where the alternative is a question, so a failure
 * costs a question and never the run.
 */
async function rememberedRoutingSelection(
  labels: string[],
  catalog: RepositoryCatalogEntry[],
): Promise<SelectedRepository | null> {
  try {
    // A ticket with no labels has nothing to look up, so it never reaches the
    // database at all.
    if (labels.length === 0) return null;
    const { orgSubjectKey, repoOwner } = await import("../../support/subject-key.js");
    const { getConnectedMemoryDocument } = await import(
      "../../../db/repositories/memory.js"
    );
    const {
      REPO_ROUTING_DOC_PATH,
      isRepoRoutingEntryEligible,
      parseRepoRoutingDocument,
      repoRoutingMatches,
    } = await import("../../../memory/repo-routing.js");

    // The catalog is exactly what a human or the discovery model would have been
    // allowed to choose from: already pin-filtered, already archive-filtered, and
    // carrying the usability the workspace needs. Validating against it is what
    // makes a remembered repository that has since left the catalog, lost its
    // default branch or been excluded by the pin ignored rather than selected.
    const usable = new Map<string, RepositoryCatalogEntry>();
    for (const entry of catalog) {
      if (entry.usable) usable.set(repositoryKey(entry), entry);
    }

    // Owners come from the WHOLE catalog, unusable entries included, so an owner
    // whose repositories have all gone unusable is still read. Its document may
    // hold testimony that disagrees with a live answer, and a veto that depends on
    // the disagreeing repository still being clonable would be a veto that
    // disappears exactly when the repository it names is renamed away.
    const owners: Array<{ provider: RepositoryMetadata["provider"]; owner: string }> = [];
    const seenOwners = new Set<string>();
    for (const entry of catalog) {
      const owner = repoOwner(entry.repoPath);
      if (owner === null) continue;
      const key = `${entry.provider}:${owner}`;
      if (seenOwners.has(key)) continue;
      seenOwners.add(key);
      owners.push({ provider: entry.provider, owner });
      if (owners.length === MAX_ROUTING_OWNERS_READ) break;
    }

    const entries: RepoRoutingEntry[] = [];
    for (const { provider, owner } of owners) {
      const stored = await getConnectedMemoryDocument(
        orgSubjectKey(provider, owner),
        REPO_ROUTING_DOC_PATH,
      );
      if (!stored) continue;
      for (const entry of parseRepoRoutingDocument(stored.content)) {
        // An entry may only ever name a repository under the owner whose document
        // holds it. Without this a document under a shared top-level namespace
        // could route a sibling tenant's ticket, which is the cross-tenant path
        // repoOwner exists to close.
        if (entry.provider !== provider || repoOwner(entry.repoPath) !== owner) continue;
        entries.push(entry);
      }
    }

    const matches = repoRoutingMatches(entries, labels);

    // Disagreement is tested over EVERY matched entry, ahead of both liveness and
    // corroboration, because liveness is a property of the repository and not of the
    // testimony. When one label says acme/checkout and another says acme/api, the
    // first has asserted "not acme/api"; finding its target renamed or archived
    // makes that testimony unactionable, it does not make it agree. Discarding it and
    // resolving to the survivor is exactly the inference the harm asymmetry forbids,
    // and it is the shape a wrong repository would take here.
    const distinct = new Set(matches.map((entry) => repositoryKey(entry)));
    if (distinct.size !== 1) {
      if (distinct.size > 1) {
        // Labels as well as repositories: a dissent on one label vetoes an
        // otherwise corroborated route, and the only way an operator can clear it
        // is to know which label carried the dissent.
        await logRouting("info", "repo_routing_ambiguous", {
          repositories: [...distinct],
          labels: matches.map((entry) => entry.label),
        });
      }
      return null;
    }
    const key = [...distinct][0]!;

    // One human answer is an observation, not evidence. Labels at a real client are
    // often generic ("bug", "P2", "sprint-42"), and a single answer binds one of
    // those as readily as a meaningful one, which would then route any later ticket
    // that merely shares the label. Two DISTINCT tickets have to have resolved the
    // same label the same way, which is the rule org fact promotion already applies
    // to facts, moved to testimony. Uncorroborated entries are still written, so the
    // second confirmation can arrive, and still counted as disagreement above, so a
    // lone dissent is never silently discarded.
    if (!matches.some(isRepoRoutingEntryEligible)) {
      await logRouting("info", "repo_routing_uncorroborated", { repository: key });
      return null;
    }

    // Liveness last, and on the single survivor only. Ignoring a stale answer means
    // asking, never falling through to a different label's answer.
    const chosen = usable.get(key);
    if (!chosen) {
      await logRouting("info", "repo_routing_stale", { repository: key });
      return null;
    }
    await logRouting("info", "repo_routing_resolved", {
      repository: `${chosen.provider}:${chosen.repoPath}`,
      labels: matches.map((entry) => entry.label),
    });
    return {
      provider: chosen.provider,
      repoPath: chosen.repoPath,
      defaultBranch: chosen.defaultBranch,
      // The matched label is deliberately NOT interpolated here: this rationale is
      // compiled into an agent prompt, and a tracker label is text a ticket author
      // controls. The label goes to the log above, which is where an operator
      // asking "why this repository" looks.
      selectedRationale: "remembered from a human answer for a matching ticket label",
    };
  } catch (err) {
    await logRouting("warn", "repo_routing_read_failed", { err: errorText(err) });
    return null;
  }
}

/**
 * Records "a ticket carrying label L in this organisation was resolved to
 * repository R by a human". The write point, because a human's which-repo answer
 * always resolves through this step: it arrives on the step's `clarification`
 * and nowhere else.
 *
 * It used to say the answer reached here as a synthetic comment appended to the
 * ticket by prepare-workspace. That append is gone (round 4, B1): it handed a
 * person's reply to a scanner that reads paths and not people, so "not
 * github:acme/billing" attached billing as a repository the TICKET named. The
 * answer has one reader now, and this function gates on the rationale that
 * reader writes rather than on anything found in the ticket's text.
 *
 * Best effort, and it may not fail the run: the selection has already succeeded by
 * the time this is called, so everything here is wrapped and swallowed.
 */
async function rememberRoutingAnswer(input: {
  labels: string[];
  clarification?: PreSandboxStepContext["clarification"];
  ticketIdentifier?: string;
  branchName: string;
  repositories: SelectedRepository[];
}): Promise<void> {
  try {
    if (input.labels.length === 0) return;
    // Structural, and the reason nothing here matches on a comment author. The field
    // is set only when the block that raised the clarification is the one that owns
    // repository selection, so a value here means the reply is an answer to "which
    // repository?" rather than a reply to some other question that happens to quote
    // a path. A display name on a tracker comment is user controlled and could
    // authenticate nothing.
    if (input.clarification?.resolves !== "repository_selection") return;
    // Corroboration counts DISTINCT tickets, so a run whose ticket cannot be
    // identified is not stored at all: an unidentifiable ticket would either read as
    // the same ticket every time, which can never corroborate, or as a new one every
    // time, which would corroborate itself.
    const ticketIdentifier = input.ticketIdentifier?.trim();
    if (!ticketIdentifier) return;
    // A reply that says no about anything decides nothing, here as everywhere:
    // the careful reader refuses it (`readRepositoryAnswer`), and a memory of
    // "this label means that repository" built from the same words would be the
    // refused decision, remembered for every later ticket.
    const answerText = input.clarification.answer.toLowerCase();
    if (commentSaysNoAboutItsPaths(input.clarification.answer)) return;
    // Both remaining conditions still matter on top of that gate. The rationale
    // is what proves a human's own reply brought this repository into the run,
    // either because the record attached what the answer named or because the
    // answer resolved it directly, rather than a pin, an owned branch or the
    // only-accessible-repository shortcut, none of which a human chose; the
    // mention is what proves this reply named it rather than some earlier
    // sentence in the ticket.
    const named = input.repositories.filter(
      (repo) =>
        (repo.selectedRationale === HUMAN_ANSWER_RATIONALE ||
          repo.selectedRationale === RECORD_RATIONALE) &&
        mentionsRepositoryPath(answerText, repo.repoPath),
    );
    // Exactly one, or nothing. With two repositories named, every label on the
    // ticket would map to both, and a label that maps to two repositories is not a
    // routing answer: it is the ambiguity the read path refuses to guess at, so it
    // is never stored in the first place.
    if (named.length !== 1) return;
    const chosen = named[0]!;

    const { orgSubjectKey, repoOwner } = await import("../../support/subject-key.js");
    const owner = repoOwner(chosen.repoPath);
    // A path with no owning namespace names no organisation to remember it under.
    if (owner === null) return;
    const { getConnectedMemoryDocument, upsertConnectedMemoryDocument } = await import(
      "../../../db/repositories/memory.js"
    );
    const { prepareMemoryContent } = await import("../../../memory/content.js");
    const {
      REPO_ROUTING_DOC_PATH,
      mergeRepoRoutingEntries,
      normalizeRoutingLabel,
      normalizeRoutingTickets,
      parseRepoRoutingDocument,
      renderRepoRoutingDocument,
      repoRoutingLabelKey,
    } = await import("../../../memory/repo-routing.js");

    // An identifier the stored shape cannot hold would round-trip to no ticket at
    // all, leaving an entry nothing could ever corroborate, so it is refused here
    // rather than written as permanently uncorroborated.
    const tickets = normalizeRoutingTickets([ticketIdentifier]);
    if (tickets.length === 0) return;

    const candidates: RepoRoutingEntry[] = [];
    const seenLabels = new Set<string>();
    for (const label of input.labels) {
      const normalized = normalizeRoutingLabel(label);
      const key = repoRoutingLabelKey(normalized);
      if (key.length === 0 || seenLabels.has(key)) continue;
      seenLabels.add(key);
      candidates.push({
        label: normalized,
        provider: chosen.provider,
        repoPath: chosen.repoPath,
        tickets,
      });
      if (candidates.length === MAX_ROUTING_ENTRIES_PER_RUN) break;
    }
    if (candidates.length === 0) return;

    // Neither the label nor the repository path may address a document: the
    // subject key comes from orgSubjectKey and the doc path is a constant.
    const subjectKey = orgSubjectKey(chosen.provider, owner);
    const stored = await getConnectedMemoryDocument(subjectKey, REPO_ROUTING_DOC_PATH);
    let existing = stored ? parseRepoRoutingDocument(stored.content) : [];
    // `stored?.version ?? 0` is the required idiom: the key may never be present
    // with an undefined value, and 0 is what means "create it".
    let expectedVersion = stored?.version ?? 0;
    for (let attempt = 1; attempt <= MAX_ROUTING_WRITE_ATTEMPTS; attempt += 1) {
      const merged = mergeRepoRoutingEntries({
        existing,
        candidates,
        maxEntries: MAX_ROUTING_ENTRIES,
        maxBytes: MAX_ROUTING_DOC_BYTES,
        owner,
      });
      // Already stored, so a repeated run does not bump the version for nothing.
      if (sameRoutingEntries(merged.entries, existing)) return;
      const prepared = prepareMemoryContent(
        renderRepoRoutingDocument({ owner, entries: merged.entries }),
        MAX_ROUTING_DOC_BYTES,
        false,
      );
      // Fail closed. Text that could not be scrubbed never reaches the store, and
      // a truncated routing document is worse than a missing one: the cut can land
      // mid-line and leave an entry naming a repository nobody chose.
      //
      // The merge already sized the pre-redaction render to this cap, so reaching
      // the truncation branch means redaction GREW the text, which happens when a
      // label quotes a configured secret and the replacement marker is longer than
      // what it replaced. Such a document is dropped whole and the warning below is
      // the only trace, which is the right trade but worth knowing when a routing
      // document mysteriously stops updating.
      if (!prepared || prepared.truncated) {
        await logRouting("warn", "repo_routing_write_skipped", { subjectKey });
        return;
      }
      const result = await upsertConnectedMemoryDocument({
        subjectKey,
        docPath: REPO_ROUTING_DOC_PATH,
        // Organisation scoped, so no ticket owns this document.
        ticketKey: null,
        content: prepared.content,
        // Pre-sandbox has no run id in its step context: PreSandboxStepContext
        // carries only the branch name, and threading one would mean editing
        // engine/pre-sandbox/types.ts, engine/steps/pre-sandbox-runner.ts and
        // engine/blocks/prepare-workspace/execute.ts. The
        // prefix marks the value as deliberately not a run id, which the dashboard
        // displays this column as, while keeping the branch for diagnostics.
        sourceRunId: `presandbox:${input.branchName}`,
        expectedVersion,
      });
      if (result.applied) {
        await logRouting("info", "repo_routing_remembered", {
          subjectKey,
          repository: `${chosen.provider}:${chosen.repoPath}`,
          labels: candidates.map((entry) => entry.label),
          dropped: merged.dropped,
        });
        return;
      }
      if (attempt === MAX_ROUTING_WRITE_ATTEMPTS) {
        await logRouting("warn", "repo_routing_write_contended", {
          subjectKey,
          attempts: MAX_ROUTING_WRITE_ATTEMPTS,
        });
        return;
      }
      // Re-read, re-merge and re-render per attempt: a lost swap means another run
      // replaced the document, and re-issuing the same bytes would discard exactly
      // the entries this loop exists to preserve.
      const fresh = await getConnectedMemoryDocument(subjectKey, REPO_ROUTING_DOC_PATH);
      existing = fresh ? parseRepoRoutingDocument(fresh.content) : [];
      expectedVersion = fresh?.version ?? 0;
    }
  } catch (err) {
    await logRouting("warn", "repo_routing_write_failed", { err: errorText(err) });
  }
}

/** Corroboration counts as a difference, not just the label and the target: a run
 *  that only confirms a stored entry leaves the same pair behind a longer ticket
 *  list, and skipping that write would leave the entry uncorroborated forever. */
function sameRoutingEntries(
  left: readonly RepoRoutingEntry[],
  right: readonly RepoRoutingEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.label === right[index]?.label &&
        entry.provider === right[index]?.provider &&
        entry.repoPath === right[index]?.repoPath &&
        entry.tickets.join(",") === right[index]?.tickets.join(","),
    )
  );
}

/** Every diagnostic on the routing path is wrapped: a failed logger import must
 *  not escape a best-effort path and take the run with it. */
async function logRouting(
  level: "info" | "warn",
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    const { logger } = await import("../../../infra/logger.js");
    logger[level]({ step: "repo-selection", ...fields }, event);
  } catch {
    // Nothing left to report with.
  }
}

/** A driver error can echo the statement, and with it the document, so bound it
 *  before it reaches a log sink. */
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Whether a provider that failed to answer could not have changed this run's
 * choice anyway. The definition pin already excludes everything it could have
 * offered, so the surviving listing is exactly what selection would have seen had
 * the provider answered, and the run proceeds on its normal path. A provider
 * carrying a workflow-owned branch for this ticket never qualifies: listedVcsProviders
 * queries it precisely so an in-flight pull request is not stranded, and treating
 * its silence as harmless would strand that pull request without saying so.
 */
function failedProviderCannotAffectSelection(
  provider: RepositoryMetadata["provider"],
  repositoryScope: WorkflowRepositoryScope | undefined,
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[],
): boolean {
  if (workflowOwnedBranches.some((branch) => branch.provider === provider)) {
    return false;
  }
  return pinnedScopeExcludesProvider(repositoryScope, provider);
}

/** Operator-facing telemetry for a provider that never answered, recorded whether
 *  or not the run survived it. */
function catalogDegradation(
  failures: RepositoryListingFailure[],
  failedClosed: boolean,
): PreSandboxRepositoryCatalogDegradation | null {
  if (failures.length === 0) return null;
  return {
    providers: failures.map((failure) => failure.provider),
    outcome: failedClosed ? "failed_closed" : "continued_degraded",
  };
}

/** Names the step the way the runner's own failureMessage does, so a run that
 *  stopped itself here stays greppable by step name exactly like a run whose
 *  listing threw. */
function incompleteCatalogMessage(
  step: PreSandboxConfigStep,
  failures: RepositoryListingFailure[],
  providers: RepositoryMetadata["provider"][],
): { message: string; cause: string } {
  const reasons = failures
    .filter((failure) => providers.includes(failure.provider))
    .map((failure) => `${failure.provider}: ${failure.message}`)
    .join("; ");
  return {
    message:
      `${step.name ?? step.uses} failed: repository listing for ${providers.join(", ")} is unavailable (${reasons}), so the repository catalog was incomplete. ` +
      "No deterministic repository signal resolved the selection, and choosing from a partial catalog could pick the wrong repository. " +
      "Retry once the provider recovers, or name the repository path in the ticket.",
    // The provider verdicts alone. They sit in the middle of the message above,
    // between the step name and the advice, which is where a head-plus-tail clamp
    // elides them; returned separately so the surfaces bound the advice instead.
    cause: reasons,
  };
}

/**
 * Providers whose listings this run needs. A pin narrows the set so an excluded
 * provider is never even queried, but a provider carrying an in-flight
 * workflow-owned branch for this ticket always stays in: losing its listing
 * would strand that branch's open pull request the moment an operator edits the
 * pin.
 */
function listedVcsProviders<T extends { kind: RepositoryMetadata["provider"] }>(
  providers: T[],
  repositoryScope: WorkflowRepositoryScope | undefined,
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[],
): T[] {
  const pinned = repositoryScope?.providers ?? [];
  if (pinned.length === 0) return providers;
  const owned = new Set(workflowOwnedBranches.map((branch) => branch.provider));
  return providers.filter(
    (provider) => pinned.includes(provider.kind) || owned.has(provider.kind),
  );
}

function scopeNarrowing(
  repositories: RepositoryMetadata[],
  repositoryScope: WorkflowRepositoryScope | undefined,
): PreSandboxRepositoryScopeNarrowing | null {
  if (!repositoryScope) return null;
  if (
    (repositoryScope.repositories?.length ?? 0) === 0 &&
    (repositoryScope.providers?.length ?? 0) === 0
  ) {
    return null;
  }
  return {
    catalogSize: repositories.length,
    scopedCatalogSize: filterPinnedRepositories(repositories, repositoryScope).length,
  };
}

/** What the selection reads of the work scope. The catalog is not here because
 *  this function builds it from the listing it already has: `usable` is known
 *  only where the repositories were LISTED. */
export interface RunWorkScopeSelectionInput {
  subjectKey: string;
  scope: WorkScope | null;
  selectionAnswered: boolean;
  /** Which repositories a question on this subject named and somebody
   *  answered, read with `scope` (see `readRunWorkScope`). */
  answeredRepositoryKeys: string[];
  /** What a PERSON wrote on this subject, dated, beside the instants it is
   *  dated against (`postAnswerComments`). The only text that may still attach
   *  a repository an answer left unnamed, so the text the question itself was
   *  asked about is deliberately not in it. Null when this run cannot tell a
   *  person's comment from the bot's, or has no instants to date against: then
   *  nothing written counts, and the person is offered the record alone. */
  postAnswer: PostAnswerComments | null;
  /** Whether the catalog decides access at all. On a bridge it does not, and a
   *  `not_enabled` entry may not expire, because every repository answers
   *  enabled there and the expiry would ask the person a second time. */
  catalogActivated: boolean;
  policy: TriggerRepositoryPolicy;
  actor: WorkScopeActor;
  now: string;
}

/**
 * The selection, plus the recorder holding every decision it made.
 *
 * The recorder is absent exactly when the caller passed no record, which keeps
 * the old path's result byte for byte what it was: no extra key, nothing to
 * apply, nothing to say.
 */
type SelectionOutcome = (
  | { status: "selected"; repositories: SelectedRepository[] }
  | {
      status: "discovery_needed";
      catalog: RepositoryCatalogEntry[];
      mandatoryRepositories: SelectedRepository[];
    }
  | { status: "clarification_needed"; questions: string[] }
  | {
      status: "catalog_incomplete";
      providers: RepositoryMetadata["provider"][];
    }
) & { workScope?: RunWorkScopeRecorder };

// More than `TEXT_MATCH_AMBIGUITY_LIMIT` decidable text matches is the ambiguity
// a person is asked about. Counted AFTER the undecidable ones are dropped, so a
// ticket naming five repositories of which two are open is not an ambiguity.

/** Entry rationales. Evidence only, never a run id or a time: an upsert whose
 *  every field equals the stored entry is not planned, so re-deriving the same
 *  ticket on every run writes nothing and appends nothing. */
const RECORD_RATIONALE = "recorded for this ticket";
const WORKFLOW_OWNED_RATIONALE = "A workflow owned branch for this ticket lives here.";
const TICKET_TEXT_ENTRY_RATIONALE = "The ticket text names this repository path.";
const ONLY_ACCESSIBLE_RATIONALE = "The only repository this run could reach.";
const ROUTING_MEMORY_RATIONALE = "A remembered routing answer for this ticket's labels.";
/** What the run stamps on a repository a person's own reply resolved. Read by
 *  `rememberRoutingAnswer`, which stores a routing memory only for a repository
 *  a human brought in. */
const HUMAN_ANSWER_RATIONALE = "human clarification answer";

export function selectRepositoriesFromMetadata(input: {
  /** The ticket's own words. A caller with no comments to separate passes
   *  everything here, and then nothing below can take a repository back. */
  ticketText: string;
  /** The comments the caller read as the person's own words, joined. Apart from
   *  the ticket's own words because a comment can be taken back by a later one
   *  and the ticket's words cannot. */
  commentText?: string;
  /** The comments the caller did not read as naming repositories, joined,
   *  absent when there are none. A repository named only here is not taken and
   *  not counted as an open match, its entry is not deleted, and it is said out
   *  loud: `ticketTextScan` holds why. Only a run with a record may have one,
   *  because the record is what carries the sentence that says it. */
  unreadCommentText?: string;
  repositories: RepositoryMetadata[];
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[];
  repositoryScope?: WorkflowRepositoryScope;
  /** Providers whose listing failed after retries and whose repositories could
   *  still have changed this choice. Absent when every provider answered, which
   *  keeps a healthy run on exactly its normal path. */
  incompleteCatalogProviders?: RepositoryMetadata["provider"][];
  /** The human's direct reply to a prior which-repo clarification question, if
   *  this is a retry. Matched leniently (short name, full path, or a small
   *  typo tolerance) against every scoped repository, separately from the
   *  strict full-path scan over free-form ticket text below. */
  directAnswer?: string | null;
  /** The record this run starts from, and the policy and pin that bound it.
   *  ABSENT IS THE WHOLE OLD PATH: with no record every signal below decides
   *  exactly what it decided before the record existed, and nothing is written. */
  workScope?: RunWorkScopeSelectionInput;
}): SelectionOutcome {
  const incompleteCatalogProviders = input.incompleteCatalogProviders ?? [];
  const catalog = buildRepositoryCatalogEntries(input.repositories);
  const usableKeys = new Set(
    catalog.filter((repo) => repo.usable).map((repo) => repositoryKey(repo)),
  );
  const usableRepositories = input.repositories.filter((repo) =>
    usableKeys.has(repositoryKey(repo)),
  );
  const repositoriesByKey = new Map(
    usableRepositories.map((repo) => [repositoryKey(repo), repo]),
  );
  const selected = new Map<string, SelectedRepository>();
  // Pure intersection over what the server already offered, so the pin can only
  // ever remove candidates. Without a pin this is the input list untouched.
  const scopedRepositories = filterPinnedRepositories(
    usableRepositories,
    input.repositoryScope,
  );
  // NOT READING A COMMENT AND NOT SAYING SO ARE TWO DIFFERENT THINGS, AND ONLY
  // THE RECORD CAN SAY IT. Every sentence a person gets about a repository this
  // run left behind rides the recorder, so without one there is nowhere to put
  // the reason, and dropping a comment silently is the failure this whole round
  // exists to end. A run with no record therefore reads the ticket exactly as it
  // always did, comments and all, and changes nothing about a path nobody can
  // be told about.
  const unreadCommentText = input.workScope ? (input.unreadCommentText ?? "") : "";
  const ownWords = (
    input.workScope
      ? input.ticketText
      : // With no record the ticket is read whole, comments and all, exactly as
        // it always was.
        [input.ticketText, input.commentText ?? "", input.unreadCommentText ?? ""].join("\n")
  ).toLowerCase();
  const commentWords = (input.workScope ? (input.commentText ?? "") : "").toLowerCase();
  // A REPOSITORY A LATER COMMENT TOOK BACK. The comment that says no is not read
  // at all, so an earlier comment naming the same repository would otherwise
  // still decide it: "use github:acme/ops", then "actually not ops", and ops is
  // taken anyway. Matched on the path AND on the bare name, because that is how
  // a person writes a second thought, and on every repository a bare name fits
  // when it fits more than one: taking a repository nobody wants is the failure
  // that lasts, and leaving one out is said out loud and undone in a comment.
  // The ticket's own words are not subject to this; they are the ticket.
  const retractedKeys = new Set(
    unreadCommentText
      ? scopedRepositories
          .filter(
            (repo) =>
              mentionsRepositoryPath(unreadCommentText.toLowerCase(), repo.repoPath) ||
              mentionsRepositoryPath(unreadCommentText.toLowerCase(), repoShortName(repo)),
          )
          .map((repo) => repositoryKey(repo))
      : [],
  );
  // AND THE TICKET'S OWN WORDS, SENTENCE BY SENTENCE. "Do NOT touch
  // github:acme/api, it is frozen." in a description used to attach api and say
  // nothing, so the run worked in the one repository the ticket had told it to
  // leave alone. A comment is read whole because it is one thought; a
  // description is many, and reading it whole would let one refused repository
  // drop every other repository the ticket names. So each sentence is read on
  // its own, and a repository whose every mention in the ticket's own words sits
  // in a sentence that says no is not taken from them, and is said out loud
  // below. A sentence ends at a full stop, a question mark, an exclamation mark
  // or a line break, none of which appear inside a repository path.
  const ownSentences = input.workScope ? sentencesOf(input.ticketText) : [];
  const takenFromOwnWords = (repo: RepositoryMetadata): boolean =>
    input.workScope
      ? ownSentences.some(
          (sentence) =>
            mentionsRepositoryPath(sentence.toLowerCase(), repo.repoPath) &&
            !commentSaysNoAboutItsPaths(sentence),
        )
      : mentionsRepositoryPath(ownWords, repo.repoPath);
  // Named by the ticket and taken from nowhere in it: every sentence that names
  // it says no about something.
  const refusedByOwnWords = (repo: RepositoryMetadata): boolean =>
    Boolean(input.workScope) &&
    mentionsRepositoryPath(ownWords, repo.repoPath) &&
    !takenFromOwnWords(repo);
  // Scanned here, above the record, because two things read it: the selection
  // below, which decides what the ticket names, and the recorder, which decides
  // from the same matches whether a path written in a comment would reach the
  // next run at all (`commentPathIsTaken`). One scan, so the run cannot leave a
  // repository out on one reading of the ticket and describe the way back on
  // another.
  const exactMatches = scopedRepositories.filter(
    (repo) =>
      takenFromOwnWords(repo) ||
      (mentionsRepositoryPath(commentWords, repo.repoPath) &&
        !retractedKeys.has(repositoryKey(repo))),
  );
  const ticketTextMatchedKeys = exactMatches.map((repo) => repositoryKey(repo));
  // The same scan over the comments the run did not read, for the two things it
  // owes a person about them: nothing in the record goes away because of one
  // (`stillNamedKeys`), and every repository they name that this run did not
  // take is said out loud (`leaveOut` below). By PATH here, not by bare name:
  // this sentence says a comment named the repository, and a bare name is
  // enough to hold a repository back without being enough to say that.
  const unreadCommentKeys = unreadCommentText
    ? scopedRepositories
        .filter((repo) => mentionsRepositoryPath(unreadCommentText.toLowerCase(), repo.repoPath))
        .map((repo) => repositoryKey(repo))
        .filter((key) => !ticketTextMatchedKeys.includes(key))
    : [];
  // And the repositories the ticket's own words name only where they say no.
  const refusedByTicketKeys = scopedRepositories
    .filter(refusedByOwnWords)
    .map((repo) => repositoryKey(repo))
    .filter((key) => !ticketTextMatchedKeys.includes(key));
  // The listing IS the catalog here, because it is already filtered by what this
  // run may touch: on a bridge that is everything the providers offered, and on
  // an activated catalog it is the enabled intersection. Usability is the one
  // fact only a listing carries, which is why the decision happens here and not
  // at run start.
  const record = input.workScope
    ? createRunWorkScopeRecorder({
        ...input.workScope,
        ticketText: ticketTextReading(input.workScope.postAnswer, ticketTextMatchedKeys),
        ...(input.repositoryScope ? { repositoryScope: input.repositoryScope } : {}),
        catalog: {
          activated: input.workScope.catalogActivated,
          enabledKeys: input.repositories.map((repo) => repositoryKey(repo)),
          unusableKeys: input.repositories
            .map((repo) => repositoryKey(repo))
            .filter((key) => !usableKeys.has(key)),
        },
      })
    : null;
  /** Every exit carries the recorder, so the caller can apply what was decided
   *  from the eight places this function returns from. */
  const done = <T extends SelectionOutcome>(result: T): SelectionOutcome =>
    record ? { ...result, workScope: record } : result;

  // The record comes first, and nothing below replaces what it seeds: every
  // signal sets a key only when the map does not already hold it. The one
  // exception is the workflow-owned branch just below, which overwrites in
  // order to ADD its branch to a repository already chosen, never to choose a
  // different one.
  if (record) {
    for (const key of record.decide({ kind: "run_started" }).attach) {
      const repo = repositoriesByKey.get(key);
      // The decision reads the catalog this function just built from the
      // listing, so an attached key is always in it. Guarded anyway rather than
      // asserted, because inventing a default branch for a repository the
      // providers did not offer is the one failure mode worth being dull about.
      if (!repo) continue;
      selected.set(key, selectedRepository(repo, RECORD_RATIONALE));
    }
  }

  // Signal 0 is the definition pin below, but a repository carrying a
  // workflow-owned branch for this ticket enters first and is never subject to
  // the pin: dropping it would strand that branch's open pull request the moment
  // an operator edits the pin.
  for (const owned of input.workflowOwnedBranches) {
    const repo = repositoriesByKey.get(repositoryKey(owned));
    if (!repo) continue;
    selected.set(repositoryKey(repo), {
      provider: repo.provider,
      repoPath: repo.repoPath,
      defaultBranch: repo.defaultBranch,
      selectedRationale: "workflow-owned branch for this ticket",
      workflowOwnedBranch: owned.branch,
    });
  }
  // A fact about the branch, re-derived on every run: when the ledger no longer
  // names a repository, the entry the last run wrote for this origin goes with
  // it. The keys are every branch the ledger holds, not only the ones the
  // listing offered, so a branch whose repository the catalog withdrew is
  // refused by name rather than silently dropped from the record.
  record?.decide({
    kind: "derived",
    origin: "workflow_owned_branch",
    repositoryKeys: record.boundEventKeys(
      input.workflowOwnedBranches.map((owned) => workScopeRepositoryKey(owned)),
    ),
    rationale: WORKFLOW_OWNED_RATIONALE,
  });

  // A path a person wrote after answering, for a repository this run cannot
  // open: not enabled, no longer usable, or outside what the workflow may take.
  // The text scan reads only the usable, pinned part of the listing, so it never
  // sees one, and the way back the recovery sentence offered would end in
  // silence. Said before the pin returns, because a pinned workflow is one of
  // the reasons. Said, not written: nothing about the work was decided.
  if (record && input.workScope) {
    const listedKeys = new Set(input.repositories.map((repo) => repositoryKey(repo)));
    for (const key of record.ticketText?.mentionedAfterAnswerKeys ?? []) {
      if (ticketTextMatchedKeys.includes(key) || selected.has(key)) continue;
      record.leaveOut(
        key,
        !listedKeys.has(key)
          ? input.workScope.catalogActivated
            ? "not_enabled"
            : "not_listed"
          : usableKeys.has(key)
            ? "outside_pin"
            : "unusable",
      );
    }
  }

  // And a path written in a comment this run did not read at all, for a
  // repository it could otherwise have taken. The person wrote the path our own
  // sentence asked them for, so the one thing that must not happen is the run
  // passing it over without a word. Said here, beside the reason above and
  // before the pin returns, so every repository the ticket names and the run
  // left behind is accounted for on the same channels.
  if (record) {
    for (const key of unreadCommentKeys) {
      if (selected.has(key)) continue;
      record.leaveOut(key, "comment_says_no");
    }
    // And the repository the ticket itself names only where it says no. Said
    // once, here, rather than left to a person noticing a repository missing
    // from a list nobody prints: the ticket named it, and a run that quietly
    // dropped it looks exactly like a run that failed to match it.
    for (const key of refusedByTicketKeys) {
      if (selected.has(key)) continue;
      record.leaveOut(key, "ticket_says_no");
    }
  }

  const pinnedRepositories = input.repositoryScope?.repositories ?? [];
  if (pinnedRepositories.length > 0) {
    const scopedByKey = new Map(
      scopedRepositories.map((repo) => [repositoryKey(repo), repo]),
    );
    const unavailable = pinnedRepositories
      .filter((pinned) => !scopedByKey.has(repositoryKey(pinned)))
      .map((pinned) => `${pinned.provider}:${pinned.repoPath}`);
    // A pin the server cannot satisfy is surfaced by name. Falling through to
    // model discovery would silently replace the operator's explicit choice, and
    // an empty selection would silently resolve the ticket to nothing.
    if (unavailable.length > 0) {
      // A pinned repository that is missing only because its provider never
      // answered is not an access problem the operator can fix in the pin.
      if (incompleteCatalogProviders.length > 0) {
        return done(incompleteCatalog(incompleteCatalogProviders));
      }
      return done({
        status: "clarification_needed",
        questions: [
          `Repositories pinned to this workflow are unavailable: ${unavailable.join(", ")}. Restore access to them or update the workflow's pinned repositories.`,
        ],
      });
    }
    for (const repo of scopedByKey.values()) {
      const key = repositoryKey(repo);
      if (!selected.has(key)) {
        selected.set(key, selectedRepository(repo, "pinned to this workflow"));
      }
    }
    // The pin short circuits the signals below, never the record: the run start
    // above already seeded what the record holds, bounded by the pin, which is
    // a capability bound rather than a policy. `filterPinnedRepositories` would
    // strip anything outside it from the run anyway.
    // The initial-match limit below exists for ambiguity between competing
    // signals. An explicit operator pin is not ambiguous, so it does not apply.
    return done({ status: "selected", repositories: [...selected.values()] });
  }

  if (record) {
    const matchedKeys = record.boundEventKeys(ticketTextMatchedKeys);
    // Filtered BEFORE it is counted: what is unreachable and what the record
    // already decided is not an open choice, so five matches of which two are
    // still open is an ordinary derivation, not an ambiguity.
    const decidable = record.decidableKeys(matchedKeys);
    // What the ticket still says and this run did not read. It decides nothing
    // and counts towards nothing; it only keeps the deletion below honest,
    // which is why it rides every ticket text event this branch raises.
    const stillNamed =
      unreadCommentKeys.length > 0
        ? { stillNamedKeys: record.boundEventKeys(unreadCommentKeys) }
        : {};
    if (decidable.length > TEXT_MATCH_AMBIGUITY_LIMIT) {
      const ambiguous = record.decide({ kind: "text_ambiguous", matchedKeys });
      if (ambiguous.ask.length === 0) {
        // The question was silenced, because this subject already carries an
        // answer or a person's own selection. Staying silent about it is worse
        // than deciding wrongly: the ticket visibly names repositories the run
        // did not open, and with nothing said the person is left to conclude
        // the run simply missed them. Say which ones, and why they were not
        // taken, so a person who has changed their mind knows there is
        // something to change.
        // Less what the decision already said, keyed, as left out of an
        // answer: one sentence per repository, never two.
        const untaken = decidable.filter(
          (key) => !selected.has(key) && !(ambiguous.unnamed ?? []).includes(key),
        );
        // A PERSON'S OWN ACTION MUST NOT TURN THE REPORT OFF. A repository
        // somebody wrote the path of after answering is no longer left out BY
        // the answer, so the sentence saying so stops being true and stops being
        // said; the ticket still names more open repositories than one run
        // chooses between, so nothing is taken either, and the question is not
        // asked again on a subject that carries an answer. The person did
        // exactly what this system asked them to do and the only channel talking
        // to them went quiet. So they are told, keyed, what happened to the path
        // they wrote and what does work.
        const writtenSinceTheAnswer = untaken.filter((key) =>
          (record.ticketText?.mentionedAfterAnswerKeys ?? []).includes(key),
        );
        for (const key of writtenSinceTheAnswer) record.leaveOut(key, "too_many_open");
        const untakenRest = untaken.filter((key) => !writtenSinceTheAnswer.includes(key));
        if (untakenRest.length > 0) {
          // TWO SENTENCES, BECAUSE THE RUN CAN BE IN TWO STATES HERE AND ONLY
          // ONE OF THEM HAS CHOICES TO HAVE KEPT TO. A person may take their
          // entries out through the edit surface, and the question stays
          // silenced afterwards because what silences it is the TRAIL, which
          // records that somebody was asked and answered; removing an entry
          // does not unmake that. So the record can hold an answer and no
          // selection at all, and "kept to the repositories already chosen"
          // then names choices that do not exist, which reads to the person who
          // just emptied the list as the run ignoring them. The suppression is
          // right and stays; it is the sentence that has to be true in both
          // states.
          record.note(
            selected.size > 0
              ? `The ticket also names ${untakenRest.join(", ")}, and this run kept to the repositories already chosen on this work rather than asking again.`
              : `The ticket names ${untakenRest.join(", ")}, and this run did not ask which of them to start from because this work already carries an answer to that question.`,
          );
        }
      }
    } else if (decidable.length > 0) {
      for (const key of record.decide({
        kind: "derived",
        origin: "ticket_text",
        repositoryKeys: decidable,
        ...stillNamed,
        rationale: TICKET_TEXT_ENTRY_RATIONALE,
      }).attach) {
        const repo = repositoriesByKey.get(key);
        if (repo && !selected.has(key)) {
          selected.set(key, selectedRepository(repo, "ticket mentions repository path"));
        }
      }
    } else if (matchedKeys.length === 0) {
      // The evidence is gone, so what the old text matched goes with it. ONLY
      // when the matcher found nothing at all: an empty event deletes this
      // origin's entries, and a corrected ticket must never empty its own scope
      // with nobody asked. A comment the run declined to read is not a ticket
      // that stopped naming a repository, which is why the words in it are
      // carried here as still named.
      record.decide({
        kind: "derived",
        origin: "ticket_text",
        repositoryKeys: [],
        ...stillNamed,
        rationale: TICKET_TEXT_ENTRY_RATIONALE,
      });
    } else {
      // Matches the run cannot take: nothing derived, nothing deleted, and the
      // reason said out loud instead of a silently empty scope.
      record.note(
        `The ticket names ${matchedKeys.join(", ")}, and this run could take none of them, so nothing was derived from its text.`,
      );
    }
  } else {
    for (const repo of exactMatches) {
      const key = repositoryKey(repo);
      if (!selected.has(key)) {
        selected.set(key, selectedRepository(repo, "ticket mentions repository path"));
      }
    }
  }

  // A question about which of several repositories to start from wins over
  // everything below: it is asked at most once per subject, and the decision
  // module has already refused to raise it a second time.
  if (record && record.ask.length > 0) {
    return done({
      status: "clarification_needed",
      questions: [
        selectionQuestion(
          record.ask.map((asked) => asked.repositoryKey),
          record.alreadyTaken,
        ),
      ],
    });
  }

  // A direct reply to a prior which-repo clarification is a much higher-
  // confidence signal than organic ticket text, so it's matched leniently: a
  // human naturally replies with a short name, not necessarily the full
  // owner/repo path the exact-mention scan above requires. Only added when it
  // resolves to exactly one repository. An ambiguous or unmatched reply is
  // left for the fallbacks below (discovery, or asking again).
  // Skipped when a record is live: a person's answer was read and recorded the
  // moment it arrived, so the run start above already attached what it named.
  // Reading the text again here would decide the same repositories a second
  // time, from prose, which is exactly the path that let one run's answer steer
  // a later run.
  //
  // AND SKIPPED FOR A REPLY THAT SAYS NO, which is the same rule the careful
  // reader keeps: "not acme/api" resolves one identity here, and taking it
  // would attach the one repository the person refused. A run with no record
  // has no channel to explain a reply it could not use, so it asks again
  // instead, which is a question rather than a silence.
  const directAnswerSaysNo =
    input.directAnswer !== undefined &&
    input.directAnswer !== null &&
    commentSaysNoAboutItsPaths(input.directAnswer);
  if (input.directAnswer && !record && !directAnswerSaysNo) {
    const normalizedAnswer = normalizeRepoAnswer(input.directAnswer);
    const answerExactMatches = scopedRepositories.filter(
      (repo) =>
        normalizeRepoAnswer(repo.repoPath) === normalizedAnswer ||
        normalizeRepoAnswer(repoShortName(repo)) === normalizedAnswer,
    );
    const answerMatches =
      answerExactMatches.length > 0
        ? answerExactMatches
        : fuzzyRepoMatches(normalizedAnswer, scopedRepositories);
    if (answerMatches.length === 1) {
      const repo = answerMatches[0]!;
      const key = repositoryKey(repo);
      if (!selected.has(key)) {
        selected.set(key, selectedRepository(repo, HUMAN_ANSWER_RATIONALE));
      }
    }
  }

  if (selected.size > 0) {
    // Without a record the count over every signal is the only ambiguity gate
    // there is, and it stays exactly what it was: nothing here may change a run
    // that never had a record.
    if (!record) {
      if (selected.size > 3) {
        if (incompleteCatalogProviders.length > 0) {
          return incompleteCatalog(incompleteCatalogProviders);
        }
        return {
          status: "clarification_needed",
          questions: [
            "More than 3 repositories match this ticket. Which repositories are essential for the initial research?",
          ],
        };
      }
      return done({ status: "selected", repositories: [...selected.values()] });
    }

    // With a record the same gate counts only what a PERSON did not decide.
    // Asking someone to narrow down their own answer is both rude and useless:
    // their answer is exactly what closes this question on this subject.
    const personDecided = new Set(
      (input.workScope?.scope?.entries ?? [])
        .filter((entry) => entry.origin === "person")
        .map((entry) => entry.repositoryKey),
    );
    const undecided = [...selected.keys()].filter((key) => !personDecided.has(key));
    if (undecided.length > TEXT_MATCH_AMBIGUITY_LIMIT) {
      if (incompleteCatalogProviders.length > 0) {
        return done(incompleteCatalog(incompleteCatalogProviders));
      }
      // Asked THROUGH the decision, never as loose prose. A question raised
      // outside the record carries no repositories, and an answer to a question
      // that carries none is dropped on arrival, so the next run counts the same
      // repositories and asks again forever. This is the same loop the ask on
      // the clarification closed, one gate further down.
      const ambiguous = record.decide({
        kind: "text_ambiguous",
        matchedKeys: record.boundEventKeys(undecided),
      });
      if (ambiguous.ask.length > 0) {
        return done({
          status: "clarification_needed",
          questions: [
            selectionQuestion(
              ambiguous.ask.map((asked) => asked.repositoryKey),
              ambiguous.alreadyTaken ?? [],
            ),
          ],
        });
      }
      // Silenced, so the run does NOT stop. This subject already carries an
      // answer or a person's own selection, and stopping on a question nobody
      // may be asked twice is the loop itself. Take the work and say what was
      // decided without asking, which is the whole defence.
      record.note(
        `This run also took ${undecided.join(", ")} without asking which repositories to start from, because the repositories on this work were already decided.`,
      );
    }
    return done({ status: "selected", repositories: [...selected.values()] });
  }

  // Degradation stops here on purpose. Every path above resolves the selection
  // from a signal that does not depend on seeing the whole catalog: a
  // workflow-owned branch for this ticket, a repository path written in the ticket,
  // a direct clarification answer naming a repository we did see, or a pin the
  // surviving listing fully satisfied. The paths below do depend on
  // it. "Only accessible repository" is a claim about the entire catalog that a
  // partial listing cannot support, and discovery hands the catalog to the model,
  // which would then choose from a set silently missing a whole provider. A
  // clarification is no safer: it presents the same partial catalog to a human as
  // if it were the full picture. Failing the run names the provider that went
  // down; the wrong repository is found much later, by a human, after the branch
  // and pull request already exist.
  if (incompleteCatalogProviders.length > 0) {
    return done(incompleteCatalog(incompleteCatalogProviders));
  }

  // A human answer that names repository paths none of which exist here gets the
  // same treatment as an unsatisfiable pin above: surfaced by name.
  //
  // The alternative is what production showed: the answer falls through to model
  // discovery, which cannot honour a repository that is not in the catalog it was
  // handed, so it asks the same question again in its own words. The human sees a
  // reworded repeat of a question they just answered and never learns that what
  // they named is not available, which is the "asks twice" loop. Only paths count
  // here: a bare short name is not evidence of an explicit choice, and the scans
  // above already resolve the ones that do match.
  //
  // Reaching this line does NOT prove that none of them matched, which is what an
  // earlier version of this block assumed. The answer scan above compares the
  // whole reply to one path or short name, so it cannot see a path sitting inside
  // a sentence ("use acme/web please"); the parser here is token-based and only
  // needs a slash, so it reads paths that scan never could. Every named identity
  // is therefore resolved against the catalog first, and only the ones that
  // genuinely do not resolve are named. Announcing that a repository sitting in
  // the catalog is unavailable is a confident, wrong statement to a human, worse
  // than the loop this fallback exists to end.
  // Gated on the record for the same reason as the whole-reply scan above, and
  // on the reply saying no for the reason that scan is: this parser resolves
  // "not acme/api" to acme/api, which is the refused repository attached by the
  // dumbest reader in the file.
  //
  // It is the LAST place where prose still decided a repository. Left open with
  // a record live it would resolve an answer a second time, at random depending
  // on how the sentence was written, and a loop caused by a question nobody
  // recorded would look like one that "sometimes works".
  if (input.directAnswer && !record && !directAnswerSaysNo) {
    const unresolved: string[] = [];
    const resolved = new Map<string, RepositoryMetadata>();
    for (const identity of parseRepositoryExpansionAnswer(input.directAnswer)) {
      const matches = resolveNamedRepository(identity, scopedRepositories);
      if (matches.length === 0) {
        unresolved.push(describeNamedRepository(identity));
        continue;
      }
      for (const repo of matches) resolved.set(repositoryKey(repo), repo);
    }
    if (unresolved.length > 0) {
      return done({
        status: "clarification_needed",
        questions: [
          `These repositories named in the previous answer are not available to this workflow: ${unresolved.join(", ")}. ` +
            `Name a repository from the accessible catalog as "owner/repo", or as "github:owner/repo" to pin the provider.`,
        ],
      });
    }
    // Everything named resolved: an explicit choice the whole-reply scan could
    // not read, and this run honours it rather than asking again.
    //
    // UP TO THE AMBIGUITY LIMIT, NOT ONE. A reply naming two repositories used
    // to fall through here, and until this round it landed anyway, because the
    // answer was also appended to the ticket and the path scan took every match
    // in it. That append is gone (it handed a refused reply to a scanner that
    // reads paths and not people), so "one" would now drop what somebody wrote,
    // on the one path that cannot tell them: a run with no record posts no
    // sentence about an answer it did not use. More than the limit is the
    // ambiguity nothing here resolves, and that still goes to discovery, which
    // asks rather than guessing.
    if (resolved.size > 0 && resolved.size <= TEXT_MATCH_AMBIGUITY_LIMIT) {
      for (const repo of resolved.values()) {
        const key = repositoryKey(repo);
        if (!selected.has(key)) {
          selected.set(key, selectedRepository(repo, HUMAN_ANSWER_RATIONALE));
        }
      }
      return done({ status: "selected", repositories: [...selected.values()] });
    }
  }

  if (scopedRepositories.length === 1) {
    const only = scopedRepositories[0]!;
    const attached =
      record === null ||
      record.decide({
        kind: "derived",
        origin: "inferred",
        repositoryKeys: [repositoryKey(only)],
        rationale: ONLY_ACCESSIBLE_RATIONALE,
      }).attach.length > 0;
    // A record that refuses the only repository this run can see leaves the run
    // on the discovery path below rather than attaching one somebody excluded.
    if (attached) {
      selected.set(repositoryKey(only), selectedRepository(only, "only accessible repository"));
      return done({ status: "selected", repositories: [...selected.values()] });
    }
  }

  // Discovery hands the catalog to the model, so enforce the bounded limit here.
  // Deterministic selection above never fails on catalog size.
  return done({
    status: "discovery_needed",
    catalog: buildRepositoryCatalog(
      filterPinnedRepositories(input.repositories, input.repositoryScope),
    ),
    mandatoryRepositories: [...selected.values()],
  });
}

/** The which-of-these question, naming every repository it asks about by its
 *  full key. The answer is read back against those keys, so a question that
 *  listed none of them could not be answered in a way anything could record.
 *
 *  IT SAYS WHAT THE ANSWER BINDS. Read as written, this asks what to research
 *  first; what it actually settles is wider and lasts: a repository this list
 *  names and the answer leaves out is refused to every later guess on this work,
 *  including the agent's own mid-run request (`isUnnamedInAnswer` in
 *  `engine/work-scope/decide.ts`). Somebody scoping one afternoon's research
 *  cannot be held to a decision nobody told them they were making, so the
 *  question tells them.
 *
 *  AND IT NAMES NO LEVER. A question is copied verbatim into the research,
 *  implementation and review prompts and into the ticket's memory file, so a
 *  sentence here naming the work scope API or `work_scope.edit` would hand the
 *  agent the undo for a person's own decision (rule 7). The way back travels
 *  beside the question instead, in the recovery note the ticket comment carries
 *  and no prompt does (`unnamedRecoveryNotes` in `engine/work-scope/context.ts`,
 *  rendered by `formatClarificationQuestionsComment`).
 *
 *  AND IT DOES NOT OFFER WHAT THE WORK ALREADY HOLDS. A matched repository the
 *  record has selected by a run's reading of the ticket, a trigger policy or a
 *  branch stays attached whatever the reply says, because an answer removes a
 *  guess and nothing else. So those are named apart, as already taken, with the
 *  one thing that does remove them said in plain words and no tool named; and
 *  the binding sentence says it covers the repositories a person may reply
 *  with, which is the whole of what it is true of. */
function selectionQuestion(
  repositoryKeys: RepositoryKey[],
  alreadyTaken: readonly RepositoryKey[],
): string {
  const head =
    `${TEXT_AMBIGUITY_QUESTION_OPENING} ` +
    "Which repositories are essential for the initial research? " +
    `Reply with one or more of: ${repositoryKeys.join(", ")}.`;
  if (alreadyTaken.length === 0) {
    return (
      `${head} A repository you do not name is left out of this work from now on, ` +
      "and no later run takes it on its own."
    );
  }
  return (
    `${head} ${KEPT_REPOSITORIES_SENTENCE_OPENING} ${alreadyTaken.join(", ")}. ` +
    "Your reply does not remove them. " +
    "Of the repositories you may reply with, one you do not name is left out of this work " +
    "from now on, and no later run takes it on its own."
  );
}

function incompleteCatalog(
  providers: RepositoryMetadata["provider"][],
): { status: "catalog_incomplete"; providers: RepositoryMetadata["provider"][] } {
  return { status: "catalog_incomplete", providers };
}

function repositoryKey(repo: Pick<RepositoryMetadata, "provider" | "repoPath">): string {
  return `${repo.provider}:${repo.repoPath.toLowerCase()}`;
}

function selectedRepository(
  repo: RepositoryMetadata,
  selectedRationale: string,
): SelectedRepository {
  return {
    provider: repo.provider,
    repoPath: repo.repoPath,
    defaultBranch: repo.defaultBranch,
    selectedRationale,
  };
}

function mentionsRepositoryPath(candidateText: string, repoPath: string): boolean {
  const escaped = repoPath.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = "[^a-z0-9/_-]";
  return new RegExp(`(^|${boundary})${escaped}($|${boundary})`).test(candidateText);
}

/**
 * Repositories one identity parsed out of a human answer resolves to. Matched
 * leniently on path or short name, the same two keys the whole-reply scan uses,
 * but per identity so a path embedded in prose still resolves. A provider-scoped
 * identity ("github:owner/repo") only ever matches that provider.
 *
 * Deliberately resolved against the *scoped* catalog: a repository a provider or
 * repository pin excludes really is not available to this workflow, so keeping it
 * out here is what makes the resulting message true.
 */
function resolveNamedRepository(
  identity: ParsedRepositoryIdentity,
  repositories: RepositoryMetadata[],
): RepositoryMetadata[] {
  const named = normalizeRepoAnswer(identity.repoPath);
  return repositories.filter(
    (repo) =>
      (identity.provider === undefined || repo.provider === identity.provider) &&
      (normalizeRepoAnswer(repo.repoPath) === named ||
        normalizeRepoAnswer(repoShortName(repo)) === named),
  );
}

function describeNamedRepository(identity: ParsedRepositoryIdentity): string {
  return identity.provider
    ? `${identity.provider}:${identity.repoPath}`
    : identity.repoPath;
}

function repoShortName(repo: Pick<RepositoryMetadata, "name" | "repoPath">): string {
  return repo.name || repo.repoPath.split("/").pop() || repo.repoPath;
}

function normalizeRepoAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/[.,;:!?]+$/, "");
}

/** No real repository short name or path is longer than this; a reply beyond
 *  it is prose, not a typo'd answer, so skip the O(n*m) edit-distance scan
 *  instead of running it against an unbounded human-supplied string. */
const MAX_TYPO_TOLERANT_ANSWER_LENGTH = 100;

/** Edit-distance budget for a typo'd clarification reply, or null when the
 *  candidate is too short to fuzzy-match safely. At length <=4 the space of
 *  one-edit neighbors ("web" ~ "wet", "wed", " web") is large relative to the
 *  number of plausible short names, so a coincidental near-miss reply could
 *  silently resolve to the wrong repository, the exact failure mode keyword
 *  scoring caused in production (see the "asks for clarification" tests
 *  above). Below that floor we require an exact match instead of guessing.
 *  Longer names get one slip up to 7 characters, two beyond that, so
 *  "arthur-engine" can absorb a dropped or transposed letter. */
function typoTolerance(value: string): number | null {
  if (value.length <= 4) return null;
  return value.length <= 7 ? 1 : 2;
}

/** Repositories within typo distance of a clarification answer with no exact
 *  match. Skipped for implausibly long replies (prose, not a typo'd name) so
 *  a human pasting an essay doesn't run an O(n*m) edit-distance scan per
 *  repo. */
function fuzzyRepoMatches(
  normalizedAnswer: string,
  repositories: RepositoryMetadata[],
): RepositoryMetadata[] {
  if (normalizedAnswer.length === 0 || normalizedAnswer.length > MAX_TYPO_TOLERANT_ANSWER_LENGTH) {
    return [];
  }
  return repositories.filter((repo) =>
    [normalizeRepoAnswer(repo.repoPath), normalizeRepoAnswer(repoShortName(repo))].some((candidate) => {
      const tolerance = typoTolerance(candidate);
      return tolerance !== null && editDistance(normalizedAnswer, candidate) <= tolerance;
    }),
  );
}

/** Damerau-Levenshtein (optimal string alignment): counts an adjacent
 *  transposition ("aip" -> "api") as a single edit, like a plain
 *  substitution or insertion/deletion, the most common typo shapes for a
 *  short reply. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1);
      }
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

/**
 * The ticket's own words, one sentence at a time.
 *
 * A sentence ends at a full stop, a question mark, an exclamation mark or a
 * line break. None of those appear inside a repository path: a path with a dot
 * in it ("acme/foo.bar") is not split, because the split needs whitespace after
 * the stop, and a bullet list is split by its own line breaks, which is what a
 * description written as a list needs.
 */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** The ticket as the path matcher reads it, in the three parts the reading of a
 *  comment splits it into. */
interface TicketTextScan {
  /** The ticket's OWN words: its key, title, description, acceptance criteria
   *  and labels. A repository named here is named by the ticket, and no comment
   *  takes that back. */
  own: string;
  /** The comments this run read, joined. A repository named only here can be
   *  taken back by a later comment that says no about it. */
  comments: string;
  /** The comments this run did not read, joined. Scanned for the paths they
   *  carry and for nothing else: what it names is not taken, is not deleted
   *  from the record either, and is said out loud. */
  unread: string;
}

/**
 * Everything on the ticket the path matcher reads, with this installation's own
 * comments left out, and with the comments that say no held apart.
 *
 * The bot's question about repositories lists repository keys, so joining every
 * comment made the workflow's own question read as if a person had written it:
 * the ticket "mentioned" exactly the repositories the run had just asked about,
 * and the next run matched them.
 *
 * `botAccountId` absent means the run could not read who the bot is, and then
 * every comment counts exactly as it did before. Dropping them all instead
 * would drop a person's comments too, and a repository named only in one would
 * stop being matched, which trades a question too many for a repository too
 * few.
 *
 * WHY A COMMENT IS READ FOR A REFUSAL AND THE TICKET'S OWN WORDS ARE NOT. The
 * description and the acceptance criteria are the ticket, the words every
 * question about this work is asked about, and "do not touch acme/api until the
 * freeze lifts" there describes the work rather than answering this run. A
 * comment is a person speaking, so it is read the way an answer is
 * (`commentSaysNoAboutItsPaths`), and read WHOLE: nothing can tell "not api,
 * but infra" from "not api or infra", and guessing attaches a repository
 * somebody declined. The cost is a comment that named one repository to use
 * beside one to leave alone, and it is paid out loud, never in silence: what
 * such a comment names is reported per repository with the way back beside it
 * (`leaveOut`), and what the record already holds stays (`stillNamedKeys`).
 */
function ticketTextScan(
  ticket: {
    identifier?: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    comments?: Array<{ author: string; accountId?: string; body: string; createdAt?: string }>;
    labels?: string[];
  },
  botAccountId?: string,
): TicketTextScan {
  const comments = (ticket.comments ?? []).filter(
    (comment) => botAccountId === undefined || comment.accountId !== botAccountId,
  );
  const saysNo = comments.filter((comment) => commentSaysNoAboutItsPaths(comment.body));
  return {
    own: [ticket.identifier, ticket.title, ticket.description, ticket.acceptanceCriteria]
      .concat(ticket.labels ?? [])
      .filter(Boolean)
      .join("\n"),
    comments: comments
      .filter((comment) => !saysNo.includes(comment))
      .map((comment) => comment.body)
      .join("\n"),
    unread: saysNo.map((comment) => comment.body).join("\n"),
  };
}

/** A person's comments, dated, and the instants they are dated against. */
interface PostAnswerComments {
  /** Per answered repository, when the newest answer that named it landed. */
  answeredAtByKey: Record<string, string>;
  /** Every comment a person wrote that carries an instant. */
  comments: Array<{ body: string; createdAtMs: number }>;
}

/**
 * The part of the ticket a PERSON wrote, dated, for the run to compare against
 * the answer that named each repository.
 *
 * WHY THE REST OF THE TICKET IS NOT IN HERE. The description and the acceptance
 * criteria are the words the which-of-these question was asked about, and they
 * are snapshotted per run, so a later run that reads them again is not hearing a
 * new decision. It took an exclusion to make that visible: strike one repository
 * off a ticket that named four and the remaining matches drop under the
 * ambiguity limit, the text branch runs, and the repositories a person declined
 * are attached and written down with nobody's name on them. Only what somebody
 * typed after answering may reopen the matter (`boundByTheAnswer` in
 * `engine/work-scope/decide.ts`).
 *
 * THREE THINGS IT CANNOT PROVE, AND ALL THREE READ AS PRE-ANSWER. Without the
 * bot's account id a comment cannot be told from our own question, which lists
 * the very repository keys the run asked about, so the whole value is null;
 * without an author id the same is true of one comment, and without a timestamp
 * it cannot be placed after anything, so that comment is dropped. Each one costs
 * a repository the person can still put back through the record, where the
 * other reading writes down a decision they did not take. And because the
 * sentence offering the comment door reads the same value, a run that cannot
 * read comments never offers that door (`commentPathIsTaken` in
 * `engine/work-scope/context.ts`).
 */
function postAnswerComments(
  ticket: PreSandboxStepContext["ticket"],
  answeredAtByKey: Record<string, string> | undefined,
  botAccountId: string | undefined,
): PostAnswerComments | null {
  if (answeredAtByKey === undefined || botAccountId === undefined) return null;
  return {
    answeredAtByKey,
    comments: (ticket.comments ?? []).flatMap((comment) => {
      if (!comment.accountId || comment.accountId === botAccountId) return [];
      const createdAtMs = comment.createdAt === undefined ? NaN : Date.parse(comment.createdAt);
      return Number.isNaN(createdAtMs) ? [] : [{ body: comment.body, createdAtMs }];
    }),
  };
}

/**
 * The one reading of the ticket the record decides the comment door on.
 *
 * `mentionedAfterAnswerKeys` is dated PER REPOSITORY: a comment counts for a
 * repository only when it came after the newest answer to a question that named
 * THAT repository. An answer to an unrelated question later on does not move
 * it, so a path a person wrote on our instructions stays theirs.
 *
 * MATCHED AGAINST THE ANSWERED KEYS, NOT THE LISTING. Only a repository an
 * answer named can be dated at all, so its key is already known, and matching
 * against the key rather than the listing reaches the one a person can no
 * longer find in it: disabled on the Repositories page, or never enabled. The
 * path is compared with the same exact matcher as the ticket's own text.
 * Whether somebody typed a path is a fact about what they wrote, and the pin,
 * the catalog and the policy still decide what the run may do with it.
 *
 * THE NEWEST COMMENT ABOUT A REPOSITORY DECIDES, AND ONE THAT SAYS NO NAMES
 * NOTHING. "Please do not touch github:acme/api" is the opposite of taking the
 * repository back, so a comment is read with the negation reading an answer
 * gets (`commentSaysNoAboutItsPaths`), on the whole comment: the reader cannot
 * tell "don't touch api, but infra" from "don't touch api or infra". That
 * leaves out some comments that meant yes, which costs a person one more step
 * and is said on the line the run writes for that repository
 * (`saidNoAfterAnswerKeys`); reading the other way attaches a repository
 * somebody declined. The newest comment wins, so a person who changes their
 * mind in a later comment is read as they now stand.
 */
function ticketTextReading(
  postAnswer: PostAnswerComments | null,
  matchedKeys: string[],
): TicketTextReading {
  if (postAnswer === null) {
    return { matchedKeys, datableKeys: [], mentionedAfterAnswerKeys: [] };
  }
  const anchorOf = (key: string): number | null => {
    const at = postAnswer.answeredAtByKey[key];
    if (at === undefined) return null;
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? null : ms;
  };
  const datableKeys = Object.keys(postAnswer.answeredAtByKey).filter(
    (key) => anchorOf(key) !== null,
  );
  const mentionedAfterAnswerKeys: string[] = [];
  const saidNoAfterAnswerKeys: string[] = [];
  for (const key of datableKeys) {
    const anchor = anchorOf(key) ?? Number.POSITIVE_INFINITY;
    const path = key.slice(key.indexOf(":") + 1);
    const name = path.slice(path.lastIndexOf("/") + 1);
    // A SECOND THOUGHT IS WRITTEN THE WAY PEOPLE WRITE ONE. "use
    // github:acme/ops", then "actually not ops": the retraction names the
    // repository by its bare name, so a reader that only knows full paths never
    // sees it and the first comment still decides. A comment counts for this
    // repository when it writes the path, or when it says no and writes the
    // name. Never the other way round: a bare name in a comment that says yes
    // is "the ops team", not a repository, and taking one nobody chose is the
    // failure that lasts.
    const about = postAnswer.comments.filter((comment) => {
      if (comment.createdAtMs <= anchor) return false;
      const body = comment.body.toLowerCase();
      if (mentionsRepositoryPath(body, path)) return true;
      return mentionsRepositoryPath(body, name) && commentSaysNoAboutItsPaths(comment.body);
    });
    // The newest wins, and a tie goes to the refusal. Two comments can carry
    // the same instant, and a tracker gives us no order inside one: reading
    // them in the order they arrived in the array would make the decision
    // depend on the provider's paging. Leaving a repository out is said out
    // loud and taken back in one comment; taking one somebody refused is not.
    const newest = about.reduce<{ body: string; createdAtMs: number } | null>((latest, comment) => {
      if (latest === null || comment.createdAtMs > latest.createdAtMs) return comment;
      if (comment.createdAtMs < latest.createdAtMs) return latest;
      return commentSaysNoAboutItsPaths(comment.body) ? comment : latest;
    }, null);
    if (newest === null) continue;
    if (commentSaysNoAboutItsPaths(newest.body)) saidNoAfterAnswerKeys.push(key);
    else mentionedAfterAnswerKeys.push(key);
  }
  return { matchedKeys, datableKeys, mentionedAfterAnswerKeys, saidNoAfterAnswerKeys };
}
