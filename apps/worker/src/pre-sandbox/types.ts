import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

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
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      questions?: string[];
      promptAdditions?: PreSandboxPromptAddition[];
      selectedRepositories?: SelectedRepository[];
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
}

export type RunPreSandboxPhaseResult =
  | {
      status: "continue";
      promptAdditions: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      questions?: string[];
      promptAdditions: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
    };
