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

export interface IssueTrackerAdapter {
  /**
   * Fetch a single ticket by key/id.
   * Throws IssueTrackerNotFoundError (code: NOT_FOUND) when the ticket does not exist.
   */
  fetchTicket(id: string): Promise<TicketContent>;
  moveTicket(id: string, column: string): Promise<void>;
  postComment(id: string, comment: string): Promise<void>;
  searchTickets(query: string): Promise<string[]>;
}
