export interface TicketContent {
  id: string;
  identifier: string;
  projectKey?: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: TicketComment[];
  /**
   * Did this read establish that `comments` is every comment on the ticket?
   *
   * A tracker hands comments over a page at a time and says how many there are.
   * The two answers a reader can get are not symmetric: a comment that is here
   * was written, while a comment that is not here was either never written or
   * simply not read, and only the provider's own count tells those apart.
   *
   * ABSENT MEANS NOT ESTABLISHED, which is the safe direction and the reason
   * this is not spelled `commentsTruncated`. A reader that concludes "nobody
   * answered" or "the words are deleted" from a list it cannot prove complete
   * nudges a person who has answered and destroys an answer that is sitting on
   * a page nobody read. Ignorance is not absence, and a field nobody set must
   * read as ignorance.
   */
  commentsComplete?: boolean;
  /**
   * The instant from which `comments` IS every comment: nothing written at or
   * after it is missing, whatever is missing was written before it.
   *
   * The narrower fact, and the one most readers actually need. A ticket too
   * long to read in one go is read from its newest end, so a list that is not
   * the whole list is still the whole of its recent end, and a reader whose
   * question opens at a known moment (a clarification asked at a known time)
   * can prove it holds every comment that could answer it. Without this a
   * two thousand comment ticket would lose a channel it does not need to lose.
   *
   * ABSENT MEANS NOT ESTABLISHED. It is set only when the read ran to the end
   * of the list, because only then is what is missing known to be older; a read
   * that stopped short could be missing the newest comment of all, and the
   * oldest comment in hand would say nothing about that.
   */
  commentsCompleteFrom?: string;
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
  /** What kind of account wrote it, in the provider's own word. Jira reports
   *  "atlassian", "customer" or "app"; two of those are people, and an app is
   *  an automation rule or an integration that cannot decide anything.
   *
   *  Optional because it must be: a tracker that does not report it, and a
   *  provider that adds a word we have never seen, both have to keep working.
   *  ABSENT MEANS A PERSON. The failure directions are not equal: reading an
   *  unknown account as an app would silently start dropping real people's
   *  answers, which is worse than counting an automation as an author. */
  accountType?: string;
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
   *
   * `commentsSince` asks for one thing the plain read does not promise: that
   * `comments` holds EVERY comment written at or after that instant, paging for
   * them if the provider handed over a page. Pass it only where that window is
   * what the caller is reading (deciding whether a question was answered, and
   * by how many people), because a provider that pages costs a request per page
   * and this call sits on the poll path. Without it the read is one request and
   * the completeness fields say what that one request could prove.
   */
  fetchTicket(id: string, options?: { commentsSince?: string }): Promise<TicketContent>;
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
  postComment(
    id: string,
    comment: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
  /**
   * Finds a previously published comment containing `marker` as an exact line.
   * Providers that expose paginated comments should scan every page so a retry
   * cannot duplicate an older side effect that fell outside fetchTicket's
   * embedded comment window.
   */
  findCommentByMarker?(
    id: string,
    marker: string,
  ): Promise<string | null>;
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
