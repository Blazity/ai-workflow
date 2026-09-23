// The messaging port lives in @integrations/sdk (ADR-010), where an
// integration implements it. Core itself talks to `MessagingSender`, which is
// the same two operations with the ticket's conversation already resolved:
// remembering which conversation a ticket owns is core's row, not a provider's.
//
// The port's own `MessagingDelivery` is not re-exported: core reads
// `CoreMessagingDelivery` (engine/support/messaging.ts), which carries the one
// fact only core can know, whether the run may still use this provider at all.
export type {
  MessageRetrievalFailure,
  MessageSearchMatch,
  MessageSearchOutcome,
  MessagingSender,
  TicketEvent,
} from "@integrations/sdk";
