import type {
  IntegrationConnectionPin,
  RunRepositoryAccess,
  SettingsSnapshot,
  TriggerRepositoryPolicy,
  WorkScopeActor,
  WorkScopeAskedRepository,
  WorkScopeQuestionPurpose,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import type {
  SelectedRepository,
  VcsProvider,
} from "../../adapters/vcs/repository-directory.js";
import type { RepositoryCatalogEntry } from "../repository-discovery/catalog.js";
import type { RunStartWorkScope } from "../steps/run-start-settings.js";
import type { RelatedTicket } from "../../adapters/issue-tracker/types.js";
import type { TicketTextReading } from "../work-scope/context.js";
import type { RepositoryMapFacts } from "../../repository-map/map.js";

/**
 * The repositories a question a pre-sandbox step raised named, and why each one
 * was asked.
 *
 * It travels out of the step because the reason is recorded when the question
 * is ASKED, never when it is answered: by answer time the clarification row
 * carries prose and nothing else, and a person's "continue without it" would
 * append a line naming no repository.
 */
export interface PreSandboxWorkScopeAsk {
  subjectKey: string;
  askedRepositories: WorkScopeAskedRepository[];
  /**
   * Why the question was put, where the list above cannot say.
   *
   * A question asking somebody to narrow a set larger than an ask may carry
   * names none of the repositories, so its ask is empty and reads exactly like
   * the plain "which repository should this ticket modify?". This is the only
   * thing that tells the two apart, and telling them apart is what stops the
   * narrowing question being asked again on every later run.
   */
  purpose?: WorkScopeQuestionPurpose;
}

/**
 * What the selection refused, keyed, on its way to the comment a finished run
 * posts.
 *
 * The prompt additions already carry these sentences to the agent, and until
 * this existed they carried them nowhere else: a ticket covering two
 * repositories, one of them excluded weeks ago, produced a green run and a pull
 * request covering half the work with nothing on the ticket saying so. Silent
 * partial work is the failure this record exists to end, and a person does not
 * go looking for a problem a green run did not report.
 *
 * Keyed rather than the flat sentences the prompt uses, because the report
 * renders one line per repository and a sentence with no key attached cannot be
 * lined up with the repositories the run did open.
 */
export interface PreSandboxWorkScopeLeftOut {
  /** `provider:owner/name`, the key the work scope record uses. */
  repositoryKey: string;
  /** Why the run left it out, as a person reads it. */
  reason: string;
}

export interface PreSandboxRepositoryDiscovery {
  catalog: RepositoryCatalogEntry[];
  mandatoryRepositories: SelectedRepository[];
}

/**
 * What every repository-working send needs to describe the repositories, read
 * once in the pre-sandbox step because nothing after it may touch a database.
 *
 * ABSENT IS A FACT, NOT AN EMPTY MAP. A run whose journal predates this field
 * hands back a result without it, and a send built from that must say the map
 * was not available rather than render an empty one, which would be a positive
 * claim that the catalog holds nothing.
 */
/**
 * How many repositories may be in the workspace before a person is asked which
 * ones are essential (`engine/blocks/prepare-workspace/execute.ts`).
 *
 * It lives here rather than in that block because the pre-sandbox decides what
 * goes into the workspace and the block decides what to do when there is too
 * much of it: two files, one number, and a run handed an unnecessary question
 * is the failure that comes from them disagreeing.
 */
export const WORKSPACE_NARROWING_CEILING = 8;

export interface PreSandboxRepositoryMap {
  /** Every repository this run knows of, with the operator's own description
   *  and the relationships, as the map renderer reads them. */
  repositories: RepositoryMapFacts[];
  /** True when the catalog profile read failed. The map then says so instead of
   *  rendering no relationships, which reads as "these are unrelated". */
  relationshipsUnreadable?: boolean;
  /** True when that same read failed, said as the wider fact it is: the
   *  operator's descriptions were in those rows too, so the map must not
   *  report every repository as one nobody ever described. */
  catalogUnreadable?: boolean;
  /** Repositories this run attached because they are related to one the ticket
   *  or the event names, so the map and the trail name the same source and the
   *  same relationship. Attached READ ONLY: nobody asked for write. */
  relatedAttachments?: Array<{
    repositoryKey: string;
    viaRepositoryKey: string;
    relationship: string;
  }>;
}

/** Telemetry for how much a definition pin reduced what selection could see. */
export interface PreSandboxRepositoryScopeNarrowing {
  /** Repositories the provider listing offered this run. A pin that selects
   *  providers keeps the excluded ones from being queried at all, so this is
   *  already provider-scoped rather than a server-wide total. */
  catalogSize: number;
  /** Repositories left after the pin narrowed that listing. */
  scopedCatalogSize: number;
}

/** A provider whose repository listing failed after the bounded retry, and how the
 *  run responded to the missing catalog. Telemetry only, never a selection input. */
export interface PreSandboxRepositoryCatalogDegradation {
  providers: VcsProvider[];
  outcome: "continued_degraded" | "failed_closed";
}

const preSandboxPromptTargets = ["research", "implementation", "review"] as const;
export type PreSandboxPromptTarget = (typeof preSandboxPromptTargets)[number];

export interface PreSandboxPromptAddition {
  target: PreSandboxPromptTarget[];
  title: string;
  content: string;
}

export type PreSandboxPromptAdditionsByTarget = Record<
  PreSandboxPromptTarget,
  PreSandboxPromptAddition[]
>;

export type PreSandboxStepResult =
  | {
      status: "continue";
      promptAdditions?: PreSandboxPromptAddition[];
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      /** The repositories every send describes, read once here. Absent means
       *  this run could not gather them, which a send says out loud. */
      repositoryMap?: PreSandboxRepositoryMap;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
      workScopeAsk?: PreSandboxWorkScopeAsk;
      /** Keyed refusals for the comment a finished run posts. The agent may
       *  see these: they are facts about this run's workspace. */
      workScopeLeftOut?: PreSandboxWorkScopeLeftOut[];
      /** What a person can do about those refusals. NEVER placed in the
       *  agent's instruction channel: see `withWorkScopeOutcome`. */
      workScopeRecoveryNotes?: string[];
      /** This step's reading of the ticket, carried so the surfaces that speak
       *  after it offer the same way back it does (`commentPathIsTaken` in
       *  `engine/work-scope/context.ts`). Absent from a run that scanned no
       *  ticket, which offers the record alone. */
      workScopeTicketText?: TicketTextReading;
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      /**
       * The fragment of `message` that names what actually broke, isolated so it
       * survives every user-facing bound.
       *
       * `message` is composed prose: step name, then the reason, then advice on
       * what to do about it. The reason therefore sits in the MIDDLE, which is
       * exactly what a head-plus-tail clamp elides, and a GitLab listing timeout
       * reached operators as "repository listing f [...] ong repository" with the
       * timeout gone (AIW-254). Only the step knows which fragment is the reason,
       * so it says so here rather than leaving the message layer to guess.
       */
      cause?: string;
      /**
       * True when `message` is already the whole thing to put in front of a
       * person: a complete sentence the step authored, not prose with a reason
       * buried in it.
       *
       * The two are opposites for the message layer and nothing downstream can
       * tell them apart. `incompleteCatalogMessage` composes step name, then the
       * provider verdicts, then advice, so its reason is in the middle and it
       * wants the generic lead plus its `cause` in parentheses. The work-scope
       * and authorization refusals beside it are one finished sentence, and
       * giving one of those a generic lead and then clamping it is how a person
       * ends up reading half of it. The step knows which it built; a string
       * comparison downstream would only guess, so the fact travels as a fact.
       *
       * Absent means composed prose, which is every producer that predates this
       * field and the only safe default: treating unknown prose as a finished
       * sentence would put a middle-clipped message in front of a person, while
       * treating a finished sentence as prose costs at worst a generic lead in
       * front of it.
       */
      messageStandsAlone?: boolean;
      questions?: string[];
      promptAdditions?: PreSandboxPromptAddition[];
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      /** The repositories every send describes, read once here. Absent means
       *  this run could not gather them, which a send says out loud. */
      repositoryMap?: PreSandboxRepositoryMap;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
      workScopeAsk?: PreSandboxWorkScopeAsk;
      /** Keyed refusals for the comment a finished run posts. The agent may
       *  see these: they are facts about this run's workspace. */
      workScopeLeftOut?: PreSandboxWorkScopeLeftOut[];
      /** What a person can do about those refusals. NEVER placed in the
       *  agent's instruction channel: see `withWorkScopeOutcome`. */
      workScopeRecoveryNotes?: string[];
      /** This step's reading of the ticket, carried so the surfaces that speak
       *  after it offer the same way back it does (`commentPathIsTaken` in
       *  `engine/work-scope/context.ts`). Absent from a run that scanned no
       *  ticket, which offers the record alone. */
      workScopeTicketText?: TicketTextReading;
    };

export const preSandboxTicketInputFields = [
  "identifier",
  "title",
  "description",
  "acceptanceCriteria",
  "comments",
  "labels",
  "relatedTickets",
] as const;

export interface PreSandboxStepContext {
  ticket: {
    identifier?: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    /** `accountId` is the tracker's stable identity for the author, and it is
     *  here for one reason: it is the only way a step can tell a comment this
     *  installation's bot wrote from one a person wrote. Optional, because a
     *  tracker that does not report it leaves it absent. */
    comments?: Array<{
      author: string;
      accountId?: string;
      body: string;
      createdAt?: string;
    }>;
    labels?: string[];
    /** The ticket's parent, subtasks and links, as the run read them. Absent
     *  when the tracker does not report them, and on a run recorded before
     *  this field reached the step. */
    relatedTickets?: RelatedTicket[];
  };
  run: {
    branchName: string;
  };
  /** Repositories pinned to the workflow definition; absent when none are. */
  repositoryScope?: WorkflowRepositoryScope;
  /** Which repositories this run may touch, frozen at its start.
   *
   *  Required, with no default. A default would be a fail-open one (the
   *  bridge), so a caller that forgot to thread it would silently offer
   *  repositories nobody enabled instead of failing to compile. A caller
   *  outside a run says so explicitly, with `{ activated: false, enabledKeys:
   *  [] }`. */
  repositoryAccess: RunRepositoryAccess;
  /** The deployment's settings, frozen at this run's start, for the same reason
   *  and by the same step as `repositoryAccess`. Required, and for the same
   *  reason: a step that reads a setting from the environment instead would
   *  answer differently on a replay. */
  settings: SettingsSnapshot;
  integrationPins?: readonly IntegrationConnectionPin[];
  /**
   * Which repositories this subject's work touches and why, frozen at run
   * start, together with whether a person has already answered the
   * which-of-these question on it.
   *
   * ABSENT IS THE WHOLE OLD PATH. A run replaying a run-start result stored
   * before the record existed, a schedule occurrence, a delivery that resolved
   * no subject and an approved plan all arrive without it, and every decision
   * below then behaves exactly as it did before the record shipped. There is no
   * empty record standing in for one that was never read.
   */
  workScope?: RunStartWorkScope;
  /** The repository policy this run's trigger stands under. Read beside
   *  `workScope`: without it nothing may be decided, because treating a missing
   *  policy as "no candidates" would start a run with no repositories and look
   *  like a decision somebody made. */
  workScopePolicy?: TriggerRepositoryPolicy;
  /** Who a decision of this run is recorded as. Absent on a run whose
   *  definition is not identified, where no entry could name its author. */
  workScopeActor?: WorkScopeActor;
  /**
   * The account this installation's bot posts as on the tracker, when the run
   * could read it.
   *
   * ABSENT MEANS UNKNOWN, never "there is no bot", and a step that cannot tell
   * the two apart counts every comment exactly as it did before: a fail-closed
   * reading here would drop a person's comments too, and a repository named
   * only in one would stop being matched.
   */
  botAccountId?: string;
  /**
   * The human reply this attempt is resuming from, present only when the block
   * that raised the clarification is the one that owns repository selection.
   *
   * A value here structurally means "this text is an answer to a which-repository
   * question", which is stronger than anything the ticket comments can establish:
   * a comment is labelled with a display name, and tracker display names are
   * user controlled, so matching on one authenticates nothing. It is also the
   * ONLY carrier now. The reply used to be appended to the ticket as a comment
   * as well, so the path scanner read it as ticket text and attached the
   * repository a person had just refused (round 4, B1). Two facts make the flag
   * sound instead. The interpreter only ever
   * hands a clarification answer back to the block that asked for it, and every
   * clarification prepare-workspace raises is a repository question.
   *
   * The second fact is NOT checkable by reading prepare-workspace alone: besides
   * its own needs_human_input exits it also returns whatever the
   * discoverRepositories callback hands back, and that callback raises its own
   * clarification carrying model-authored questions. Those are repository
   * questions today because the discovery prompt asks nothing else. Anyone
   * teaching that callback to ask about something else has to narrow this flag at
   * the same time, or a reply about something else gets recorded as a repository
   * answer.
   */
  clarification?: {
    answer: string;
    /** Widened the day a pre-sandbox step starts asking about something else. */
    resolves: "repository_selection";
  };
}

type PreSandboxOnFailure = "continue" | "fail" | "move_to_backlog";

export interface PreSandboxConfigStep<StepId extends string = string> {
  uses: StepId;
  name?: string;
  timeoutMs?: number;
  onFailure: PreSandboxOnFailure;
  with?: unknown;
}

export interface PreSandboxConfig<StepId extends string = string> {
  preSandbox: {
    steps: PreSandboxConfigStep<StepId>[];
  };
}

interface PreSandboxStepExecutionInput {
  context: PreSandboxStepContext;
  config: unknown;
  step: PreSandboxConfigStep;
}

export type PreSandboxStepHandler = (
  input: PreSandboxStepExecutionInput,
) => Promise<PreSandboxStepResult>;

export type PreSandboxStepRegistry = Record<string, PreSandboxStepHandler>;

export interface RunPreSandboxPhaseInput {
  ticket: PreSandboxStepContext["ticket"];
  run: PreSandboxStepContext["run"];
  /** Forwarded onto every step's context by the runner. Required for the same
   *  reason it is required there: there is no safe default. */
  repositoryAccess: PreSandboxStepContext["repositoryAccess"];
  /** Forwarded onto every step's context by the runner, same as above. */
  settings: PreSandboxStepContext["settings"];
  integrationPins?: PreSandboxStepContext["integrationPins"];
  repositoryScope?: PreSandboxStepContext["repositoryScope"];
  clarification?: PreSandboxStepContext["clarification"];
  /** Forwarded onto every step's context by the runner. Optional, and absent
   *  means the whole old path: see `PreSandboxStepContext`. */
  workScope?: PreSandboxStepContext["workScope"];
  workScopePolicy?: PreSandboxStepContext["workScopePolicy"];
  workScopeActor?: PreSandboxStepContext["workScopeActor"];
  botAccountId?: PreSandboxStepContext["botAccountId"];
}

export type RunPreSandboxPhaseResult =
  | {
      status: "continue";
      promptAdditions: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      /** The repositories every send describes, read once here. Absent means
       *  this run could not gather them, which a send says out loud. */
      repositoryMap?: PreSandboxRepositoryMap;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
      workScopeAsk?: PreSandboxWorkScopeAsk;
      /** Keyed refusals for the comment a finished run posts. The agent may
       *  see these: they are facts about this run's workspace. */
      workScopeLeftOut?: PreSandboxWorkScopeLeftOut[];
      /** What a person can do about those refusals. NEVER placed in the
       *  agent's instruction channel: see `withWorkScopeOutcome`. */
      workScopeRecoveryNotes?: string[];
      /** This step's reading of the ticket, carried so the surfaces that speak
       *  after it offer the same way back it does (`commentPathIsTaken` in
       *  `engine/work-scope/context.ts`). Absent from a run that scanned no
       *  ticket, which offers the record alone. */
      workScopeTicketText?: TicketTextReading;
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      /** See `PreSandboxStepResult`: the reason inside `message`, isolated so it
       *  survives the user-facing bounds. */
      cause?: string;
      /** See `PreSandboxStepResult`: true when `message` is a finished sentence
       *  for a person rather than composed prose. */
      messageStandsAlone?: boolean;
      questions?: string[];
      promptAdditions: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      /** The repositories every send describes, read once here. Absent means
       *  this run could not gather them, which a send says out loud. */
      repositoryMap?: PreSandboxRepositoryMap;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
      workScopeAsk?: PreSandboxWorkScopeAsk;
      /** Keyed refusals for the comment a finished run posts. The agent may
       *  see these: they are facts about this run's workspace. */
      workScopeLeftOut?: PreSandboxWorkScopeLeftOut[];
      /** What a person can do about those refusals. NEVER placed in the
       *  agent's instruction channel: see `withWorkScopeOutcome`. */
      workScopeRecoveryNotes?: string[];
      /** This step's reading of the ticket, carried so the surfaces that speak
       *  after it offer the same way back it does (`commentPathIsTaken` in
       *  `engine/work-scope/context.ts`). Absent from a run that scanned no
       *  ticket, which offers the record alone. */
      workScopeTicketText?: TicketTextReading;
    };
