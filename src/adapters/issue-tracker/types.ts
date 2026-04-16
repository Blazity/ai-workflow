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
  body: string;
  createdAt: string;
}

export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
}

export interface IssueTrackerAdapter {
  /**
   * Fetch a single ticket by key/id.
   * Throws IssueTrackerNotFoundError (code: NOT_FOUND) when the ticket does not exist.
   */
  fetchTicket(id: string): Promise<TicketContent>;
  moveTicket(id: string, column: string): Promise<void>;
  postComment(id: string, comment: string): Promise<void>;
  searchTickets(query: string): Promise<string[]>;
  /**
   * Download an attachment by URL. Optional — not all issue trackers support this.
   * Implementations should handle auth and redirects (e.g. signed CDN URLs) internally.
   */
  downloadAttachment?(url: string, opts?: { timeoutMs?: number }): Promise<Buffer>;
}
