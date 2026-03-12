export interface TicketAdapter {
  getTicket(externalId: string): Promise<Ticket>;
  addComment(externalId: string, body: string): Promise<void>;
  moveTicket(externalId: string, columnName: string): Promise<void>;
}

export interface Ticket {
  externalId: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  comments: TicketComment[];
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: Date;
}
