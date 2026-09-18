// The messaging port lives in @integrations/sdk (ADR-010), where an
// integration can implement it. Every name core imported from here is still
// exported from here, with the same kind, so no caller changed.
export type { MessagingAdapter, TicketEvent } from "@integrations/sdk";
