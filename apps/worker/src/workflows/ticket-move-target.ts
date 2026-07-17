// Maps an update_ticket_status block's `target` param to its move destination.
// "backlog" moves to the backlog; every other value (including "ai_review",
// unknown strings, empty, or undefined) moves to AI review.
export function resolveTicketMoveTarget(target: unknown): "ai_review" | "backlog" {
  return target === "backlog" ? "backlog" : "ai_review";
}
