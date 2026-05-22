import type {
  VCSAdapter,
  CheckRunAnnotation,
} from "../adapters/vcs/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

export const postPrGateTicketInputFields = [
  "identifier",
  "title",
  "description",
  "acceptanceCriteria",
  "comments",
  "labels",
] as const;
export type PostPrGateTicketInputField = (typeof postPrGateTicketInputFields)[number];

export interface PostPrGatePrInfo {
  number: number;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
  author: string;
  isDraft: boolean;
}

export interface PostPrGateTicket {
  identifier?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  comments?: Array<{ author: string; body: string; createdAt?: string }>;
  labels?: string[];
}

export interface PostPrGateFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: "added" | "removed" | "modified" | "renamed";
}

export interface PostPrGateStepContext {
  pr: PostPrGatePrInfo;
  ticket: PostPrGateTicket | null;
  diff: string | null;
  files: PostPrGateFile[] | null;
  adapters: {
    vcs: VCSAdapter;
    issueTracker: IssueTrackerAdapter;
  };
}

export type PostPrGateStepConclusion = "success" | "failure" | "neutral";

export interface PostPrGateStepResult {
  conclusion: PostPrGateStepConclusion;
  summary: string;
  details?: string;
  annotations?: CheckRunAnnotation[];
}

export type PostPrGateOnFailure = "continue" | "fail";

export interface PostPrGateConfigStep<StepId extends string = string> {
  uses: StepId;
  name?: string;
  timeoutMs?: number;
  onFailure: PostPrGateOnFailure;
  with?: unknown;
}

export interface PostPrGateRunOn {
  botPrsOnly: boolean;
  draftPrs: boolean;
  baseBranches: string[];
}

export interface PostPrGateConfig<StepId extends string = string> {
  postPrGate: {
    runOn: PostPrGateRunOn;
    steps: PostPrGateConfigStep<StepId>[];
  };
}

export interface PostPrGateStepExecutionInput {
  context: PostPrGateStepContext;
  config: unknown;
  step: PostPrGateConfigStep;
}

export type PostPrGateStepHandler = (
  input: PostPrGateStepExecutionInput,
) => Promise<PostPrGateStepResult>;

export type PostPrGateStepRegistry = Record<string, PostPrGateStepHandler>;
