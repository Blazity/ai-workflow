export interface TicketContent {
  id: string;
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: TicketComment[];
  labels: string[];
  trackerStatus: string;
  attachments: TicketAttachment[];
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
