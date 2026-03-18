export interface TicketAdapter {
  fetchTicket(id: string): Promise<Ticket>;
  moveTicket(id: string, column: string): Promise<void>;
  postComment(id: string, comment: string): Promise<void>;
  parseWebhook(req: unknown): NormalizedEvent | null;
  searchTickets(jql: string): Promise<string[]>;
}

export interface Ticket {
  externalId: string;
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  comments: TicketComment[];
  labels: string[];
  trackerStatus: string;
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: Date;
}

export interface NormalizedEvent {
  type: "ticket_moved";
  ticketId: string;
  fromColumn: string;
  toColumn: string;
  triggeredBy: string;
  triggeredByAccountId: string;
}
