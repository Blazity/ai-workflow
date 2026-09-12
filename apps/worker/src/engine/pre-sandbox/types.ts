import type {
  RunRepositoryAccess,
  SettingsSnapshot,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import type {
  SelectedRepository,
  VcsProvider,
} from "../../adapters/vcs/repository-directory.js";
import type { RepositoryCatalogEntry } from "../repository-discovery/catalog.js";

export interface PreSandboxRepositoryDiscovery {
  catalog: RepositoryCatalogEntry[];
  mandatoryRepositories: SelectedRepository[];
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
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
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
      questions?: string[];
      promptAdditions?: PreSandboxPromptAddition[];
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
    };

export const preSandboxTicketInputFields = [
  "identifier",
  "title",
  "description",
  "acceptanceCriteria",
  "comments",
  "labels",
] as const;

export interface PreSandboxStepContext {
  ticket: {
    identifier?: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    comments?: Array<{ author: string; body: string; createdAt?: string }>;
    labels?: string[];
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
  /**
   * The human reply this attempt is resuming from, present only when the block
   * that raised the clarification is the one that owns repository selection.
   *
   * A value here structurally means "this text is an answer to a which-repository
   * question", which is stronger than anything the ticket comments can establish:
   * the synthetic comment carrying the reply is labelled with a display name, and
   * tracker display names are user controlled, so matching on one authenticates
   * nothing. Two facts make the flag sound instead. The interpreter only ever
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
  repositoryScope?: PreSandboxStepContext["repositoryScope"];
  clarification?: PreSandboxStepContext["clarification"];
}

export type RunPreSandboxPhaseResult =
  | {
      status: "continue";
      promptAdditions: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      /** See `PreSandboxStepResult`: the reason inside `message`, isolated so it
       *  survives the user-facing bounds. */
      cause?: string;
      questions?: string[];
      promptAdditions: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
    };
