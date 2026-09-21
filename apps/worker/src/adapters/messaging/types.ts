// The messaging port lives in @integrations/sdk (ADR-010), where an
// integration implements it. Core itself talks to `MessagingSender`, which is
// the same two operations with the ticket's conversation already resolved:
// remembering which conversation a ticket owns is core's row, not a provider's.
export type {
  MessageRetrievalFailure,
  MessageSearchMatch,
  MessageSearchOutcome,
  MessagingDelivery,
  MessagingSender,
  TicketEvent,
} from "@integrations/sdk";
