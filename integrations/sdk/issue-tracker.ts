/**
 * The `issue_tracker` capability port: what an integration implements so core
 * can read tickets, move them between statuses and comment on them. One
 * provider is active per deployment.
 *
 * Moved from `apps/worker/src/adapters/issue-tracker/types.ts`, which
 * re-exports every name, so no core caller changed. The provider-specific
 * leftovers still in this port (a transition id named after Jira's, a Node
 * `Buffer`) are listed as debt in ADR-010 with what removes each.
 */
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

/**
 * How a tracker reads a query a workflow author typed (the `providerQuery` of
 * `findTickets`), answered without a connection: a pure function of the text,
 * the same for every account and every project.
 *
 * The query is written in the tracker's own language, so only the tracker can
 * say whether it would run it. Core asks when a definition is saved, and the
 * author hears there about a query the adapter would otherwise drop at run
 * time, when the block searches without it and nobody is told. It is the
 * adapter's own rule, so `findTickets` must use a query exactly when this
 * finds no problem with it.
 *
 * Not a method of the adapter, for the reason `VcsHandleIdentity` is not: an
 * adapter is per connection and core reaches one lazily, while saving a
 * definition must not wait on a tracker being reachable.
 */
export interface IssueTrackerQueryRule {
  /**
   * Why this tracker would not run the query, as one or two sentences for the
   * person who wrote it, or `null` when it would. A tracker with no query
   * language says so here rather than accepting a query it will ignore.
   */
  problem(query: string): string | null;
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
   * Create a ticket in the adapter's configured project. Optional: the platform's own
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
  /**
   * The keys of every ticket sitting in one status, oldest first.
   *
   * The question core actually asks, rather than a query it composed. Until
   * S12 this was `searchTickets(query: string)` and the poller built
   * `project = "X" AND status = "Y" ORDER BY created ASC` itself, which put
   * one provider's query language in a shared interface and made a tracker
   * that cannot parse JQL impossible to write.
   *
   * ORDER MATTERS, and it is part of the contract rather than a nicety: the
   * answer is capped, so without a stable order a still queued ticket rotates
   * out of one poll's page and back into the next, and the at-capacity
   * bookkeeping deletes and re-inserts its row, which is a duplicate "waiting
   * for capacity" comment on the same ticket.
   *
   * Scope is the provider's own: an implementation answers for the project,
   * team or board its connection names, and never for anything else.
   */
  ticketsInStatus(status: string, options?: { limit?: number }): Promise<string[]>;
  /**
   * The keys of every ticket carrying one label.
   *
   * Idempotency, in practice. A caller that creates a ticket writes a marker
   * label WITH it and looks the marker up before creating another, so a lost
   * reply cannot leave two tickets and a second run started on the duplicate.
   *
   * Optional, and a caller that cannot have it must REFUSE rather than carry
   * on: "I could not check" and "there is no such ticket" are the same empty
   * answer from here, and treating the first as the second is how the
   * duplicate gets created.
   */
  ticketsWithLabel?(label: string): Promise<string[]>;
  /**
   * Tickets worth reading about a subject, with enough content to judge
   * relevance without a second fetch each. Optional: a tracker with no search
   * has none, and the caller says so rather than pretending it found nothing.
   *
   * `providerQuery` is a query a workflow author typed, in whatever language
   * their tracker speaks. Core never composes one and never reads one: it
   * carries the author's own string through. A provider that cannot parse it
   * IGNORES it and answers from `keywords`, because a workflow authored
   * against one tracker must not go silent when the deployment changes
   * tracker.
   */
  findTickets?(input: {
    keywords: readonly string[];
    limit: number;
    providerQuery?: string;
  }): Promise<TicketSummary[]>;
  /**
   * Add and/or remove labels on a ticket. Optional: not all issue trackers
   * support label mutation.
   */
  updateLabels?(
    id: string,
    changes: { add?: string[]; remove?: string[] },
  ): Promise<void>;
  /**
   * Account id of the account this connection authenticates as.
   *
   * REQUIRED, and it is the one method on this port that is load-bearing for
   * safety rather than for features. It answers "was that us": the product
   * moves a ticket itself when a run finishes or parks, every such move fires
   * the tracker's own webhook, and the only thing separating that echo from a
   * person dragging the ticket out is whether the actor is this account.
   *
   * It was optional until S12, and the failure that made it required is worth
   * spelling out: an implementation that simply left it out compiled, logged
   * nothing, and made the product cancel its own runs the instant it finished
   * them, with every log line reading as though a human had done it. There is
   * no safe default for "who acted", so there is no optionality here. A
   * tracker that genuinely cannot say is not one this product can drive a
   * ticket lifecycle on.
   *
   * Throwing is a different thing from not implementing it, and it stays
   * allowed: a token without permission to read its own account is a real
   * state. The caller then treats the actor as UNKNOWN and says so, rather
   * than deciding it was a person.
   */
  getCurrentUserAccountId(): Promise<string>;
  /**
   * Download an attachment by URL. Optional: not all issue trackers support this.
   * Implementations should handle auth and redirects (e.g. signed CDN URLs) internally.
   */
  downloadAttachment?(url: string, opts?: { timeoutMs?: number }): Promise<Buffer>;
}
