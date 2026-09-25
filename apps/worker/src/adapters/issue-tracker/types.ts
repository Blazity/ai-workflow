// The issue tracker port lives in @integrations/sdk (ADR-010), where an
// integration can implement it. Every name core imported from here is still
// exported from here, with the same kind, so no caller changed.
export {
  IssueTrackerInputRejectedError,
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type IssueTrackerMoveTarget,
  type RelatedTicket,
  type TicketAttachment,
  type TicketComment,
  type TicketContent,
  type TicketSummary,
} from "@integrations/sdk";
