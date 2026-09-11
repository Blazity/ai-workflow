import type { JsonValue } from "./domain";

export type PrTriggerType =
  | "trigger_pr_created"
  | "trigger_pr_ready"
  | "trigger_pr_updated"
  | "trigger_pr_checks_failed"
  | "trigger_pr_review"
  | "trigger_pr_merged";

export interface PrTriggerPayload {
  provider: "github" | "gitlab";
  repoPath: string;
  providerProjectId?: number | string;
  prNumber: number;
  prUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  title: string;
  author: string;
  isDraft: boolean;
  mergeSha?: string;
  mergedAt?: string;
  pipelineId?: number;
  failedChecks?: Array<{
    name: string;
    conclusion: string;
    detailsUrl?: string;
    checkRunId?: number;
    appSlug?: string;
  }>;
  review?: { state: "changes_requested" | "commented"; author: string; body: string };
  reviews?: Array<{ state: "changes_requested" | "commented"; author: string; body: string }>;
}

export interface TriggerEvent {
  delivery: {
    provider: "github" | "gitlab";
    producer: string;
    source?: string;
    deliveryId: string;
    semanticKey?: string;
  };
  triggerType: PrTriggerType;
  pr: PrTriggerPayload;
}

export interface SupportCase {
  [key: string]: JsonValue;
  provider: "zendesk" | "sentry";
  endpoint: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  description: string;
  severity: string;
  priority: string;
  reporter: string;
  customerContext: JsonValue;
  metadata: JsonValue;
}

export interface WebhookTriggerEntry {
  subject: string;
  description: string;
  requester: string;
  priority: string;
  payload: JsonValue;
  supportCase?: SupportCase;
}

export type WebhookVerifiedWith = "current" | "previous";
