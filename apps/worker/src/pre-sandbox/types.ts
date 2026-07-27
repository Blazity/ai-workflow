import type { WorkflowRepositoryScope } from "@shared/contracts";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
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

export const preSandboxPromptTargets = ["research", "implementation", "review"] as const;
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
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      questions?: string[];
      promptAdditions?: PreSandboxPromptAddition[];
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
    };

export const preSandboxTicketInputFields = [
  "identifier",
  "title",
  "description",
  "acceptanceCriteria",
  "comments",
  "labels",
] as const;
export type PreSandboxTicketInputField = (typeof preSandboxTicketInputFields)[number];

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
}

export type PreSandboxOnFailure = "continue" | "fail" | "move_to_backlog";

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

export interface PreSandboxStepExecutionInput {
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
  repositoryScope?: PreSandboxStepContext["repositoryScope"];
}

export type RunPreSandboxPhaseResult =
  | {
      status: "continue";
      promptAdditions: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      questions?: string[];
      promptAdditions: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
    };
