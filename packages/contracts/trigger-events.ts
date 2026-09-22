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

/**
 * One thing that happened to a ticket, as the issue tracker that sent it
 * understood it and as core is willing to act on it.
 *
 * The split is the whole of decision 8. The integration owns the provider:
 * it verifies the signature, reads the provider's own encoding, and answers
 * the one question core cannot ask from outside, which is whether the account
 * that acted was this deployment's own. Core owns the product: which column
 * counts as the AI column, which runs are live, what cancelling does, whether
 * a question is waiting for an answer. Neither half can be written by the
 * other, and a second issue tracker fills exactly this shape.
 *
 * Nothing here is a status core compares against a provider's vocabulary: a
 * status is a name the operator configured on the board and core compares it
 * against the operator's own settings.
 */
export interface TrackerTicketEvent {
  /**
   * Deliberately NO provider field.
   *
   * The subject key a ticket run is claimed under has exactly one derivation,
   * `ticketSubject` in the worker, taken from the id of the integration that
   * SERVES the issue tracker capability on this deployment. An event that
   * carried its own provider word gave core a second way to spell that key,
   * agreeing with the first only because one integration happened to hardcode
   * the same string. Disagreement would not be a failure: it would be a live
   * run that dispatch could start and cancel could never find.
   */
  ticketKey: string;
  /**
   * The status the delivery's own snapshot carries, or null when the delivery
   * did not say. NULL IS NOT "no status": the tracker may send an issue
   * envelope without one, and core then asks the tracker where the ticket is
   * rather than assuming it is nowhere.
   */
  status: string | null;
  /** The provider's id for that status, when the delivery carried one. */
  statusId: string | null;
  /**
   * The status change THIS delivery carried, never the snapshot.
   *
   * A snapshot says where the ticket is now, which is also true of a delivery
   * about a comment or a label. Only a real change entry is evidence that
   * somebody moved the ticket, and moving it is the gesture core acts on.
   * Null when the delivery changed no status.
   */
  statusChange: { id?: string; name?: string } | null;
  /**
   * Who made the change, in the only terms core can act on.
   *
   * REQUIRED and three-valued, because there is no honest default. `self` is
   * this deployment's own tracker account, which is the product's own
   * finalisation echoing back and must never read as a person. `other` is
   * somebody else. `unknown` is a tracker that could not be asked, most often
   * a token without permission to read its own account: core then acts as it
   * would for `other`, which is the safe direction, and says out loud that it
   * could not tell, so an operator can see the check is dead instead of
   * discovering it through cancelled runs.
   */
  actor: "self" | "other" | "unknown";
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
