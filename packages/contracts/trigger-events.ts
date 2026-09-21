import type { JsonValue } from "./domain";

export type PrTriggerType =
  | "trigger_pr_created"
  | "trigger_pr_ready"
  | "trigger_pr_updated"
  | "trigger_pr_checks_failed"
  | "trigger_pr_review"
  | "trigger_pr_merged";

export interface PrTriggerPayload {
  /** Integration id of the version-control provider that owns the repository. */
  provider: string;
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
  failedChecks?: Array<{
    name: string;
    conclusion: string;
    detailsUrl?: string;
    /** Opaque identity minted by the provider and compared without parsing. */
    handle?: unknown;
  }>;
  review?: { state: "changes_requested" | "commented"; author: string; body: string };
  reviews?: Array<{ state: "changes_requested" | "commented"; author: string; body: string }>;
}

export interface TriggerEvent {
  delivery: {
    provider: string;
    producer: string;
    source?: string;
    /** Whether the provider considers this producer trusted by default. */
    trustedByDefault?: boolean;
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
