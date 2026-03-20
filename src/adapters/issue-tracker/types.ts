export interface TicketContent {
  id: string;
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: TicketComment[];
  labels: string[];
  trackerStatus: string;
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueTrackerAdapter {
  fetchTicket(id: string): Promise<TicketContent>;
  moveTicket(id: string, column: string): Promise<void>;
  postComment(id: string, comment: string): Promise<void>;
  searchTickets(query: string): Promise<string[]>;
}
