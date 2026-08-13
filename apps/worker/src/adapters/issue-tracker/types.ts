export interface TicketContent {
  id: string;
  identifier: string;
  projectKey?: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: TicketComment[];
  labels: string[];
  trackerStatus: string;
  trackerStatusId?: string;
  attachments: TicketAttachment[];
}

export class IssueTrackerNotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = "IssueTrackerNotFoundError";
  }
}

export interface TicketComment {
  author: string;
  /** Stable account id of the comment author, used to recognise the bot's own comments. */
  accountId?: string;
  body: string;
  createdAt: string;
}

export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl?: string;
}

/**
 * One search hit, carrying enough for a human or an LLM to judge relevance
 * without a second fetch per ticket: who filed it, where it lives, when it last
 * moved, and a bounded snippet of its body. Every field is always present
 * (empty string when the provider does not report it) so consumers never have
 * to branch on undefined.
 */
export interface TicketSummary {
  key: string;
  summary: string;
  status: string;
  url: string;
  /** Bounded plain-text snippet of the description, never the whole body. */
  excerpt: string;
  /** Display name of whoever filed it. */
  reporter: string;
  /** Project key the ticket belongs to. */
  project: string;
  /** Last update, ISO 8601. */
  updatedAt: string;
}

export interface IssueTrackerTransitionTarget {
  name: string;
  transitionId?: string;
  /** Provider status id. Resolved against the destination of currently valid
   * transitions at execution time; distinct from the transition action id. */
  statusId?: string;
}

export type IssueTrackerMoveTarget = string | IssueTrackerTransitionTarget;

export interface IssueTrackerAdapter {
  /**
   * Fetch a single ticket by key/id.
   * Throws IssueTrackerNotFoundError (code: NOT_FOUND) when the ticket does not exist.
   */
  fetchTicket(id: string): Promise<TicketContent>;
  moveTicket(id: string, target: IssueTrackerMoveTarget): Promise<void>;
  /**
   * The status a move target actually lands in, resolved through the provider's
   * own transition metadata using the same matching moveTicket applies.
   *
   * A configured target may name a TRANSITION rather than the status it leads
   * to, and a provider is free to give the two different display names (Jira
   * localizes statuses but not transitions). Callers that must recognise the
   * destination therefore cannot compare display names; they resolve it here
   * and compare status ids. Null when the target does not resolve from where
   * the ticket currently sits. Optional.
   */
  resolveMoveTargetStatus?(
    id: string,
    target: IssueTrackerMoveTarget,
  ): Promise<{ id: string; name: string } | null>;
  /** Statuses configured for the adapter's project, for workflow authoring. */
  listStatuses?(): Promise<Array<{ id: string; name: string }>>;
  /**
   * Post a comment on a ticket.
   *
   * Returns a deep-linkable URL to the created comment when the underlying
   * tracker exposes one (e.g. Jira's `?focusedCommentId=...`), or `null` when
   * unavailable so callers can fall back to a plain ticket link.
   */
  postComment(id: string, comment: string): Promise<string | null>;
  /**
   * Create a ticket in the adapter's configured project. Optional — the platform's own
   * work never creates tickets (it reacts to ones people file), so an implementation
   * without this is complete; callers must handle its absence.
   *
   * `labels` is written WITH the ticket rather than added afterwards, because a caller
   * that marks a ticket for idempotency needs the mark to exist for certain the moment
   * the ticket does.
   */
  createTicket?(input: {
    summary: string;
    description?: string;
    /** Provider issue type name. Defaults to the provider's ordinary task type. */
    issueType?: string;
    labels?: string[];
  }): Promise<{ identifier: string; url: string | null }>;
  searchTickets(query: string): Promise<string[]>;
  /**
   * Search tickets returning content (summary, status, browse url) for context
   * retrieval. Optional — not all issue trackers support summary search.
   */
  searchTicketSummaries?(
    jql: string,
    maxResults: number,
  ): Promise<TicketSummary[]>;
  /**
   * Add and/or remove labels on a ticket. Optional — not all issue trackers
   * support label mutation.
   */
  updateLabels?(
    id: string,
    changes: { add?: string[]; remove?: string[] },
  ): Promise<void>;
  /**
   * Account id of the authenticated (bot) user, used to recognise the app's own
   * comments. Optional — not all issue trackers expose a "current user" concept.
   */
  getCurrentUserAccountId?(): Promise<string>;
  /**
   * Download an attachment by URL. Optional — not all issue trackers support this.
   * Implementations should handle auth and redirects (e.g. signed CDN URLs) internally.
   */
  downloadAttachment?(url: string, opts?: { timeoutMs?: number }): Promise<Buffer>;
}
