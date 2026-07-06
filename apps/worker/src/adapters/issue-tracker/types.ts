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

export interface IssueTrackerTransitionTarget {
  name: string;
  transitionId?: string;
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
   * Post a comment on a ticket.
   *
   * Returns a deep-linkable URL to the created comment when the underlying
   * tracker exposes one (e.g. Jira's `?focusedCommentId=...`), or `null` when
   * unavailable so callers can fall back to a plain ticket link.
   */
  postComment(id: string, comment: string): Promise<string | null>;
  searchTickets(query: string): Promise<string[]>;
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
