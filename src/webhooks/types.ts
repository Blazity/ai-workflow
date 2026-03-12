export type TicketTransitionEvent = {
  source: "jira" | "linear";
  externalTicketId: string;
  fromColumn: string;
  toColumn: string;
  actor: string;
};
