import type { IssueTrackerMoveTarget } from "../adapters/issue-tracker/types.js";

interface ConfiguredMoveTargets {
  backlog: IssueTrackerMoveTarget;
  aiReview: IssueTrackerMoveTarget;
}

/** Preserve provider status ids selected by workflow authors. The two legacy
 * symbolic values still resolve through environment-configured destinations. */
export function resolveTicketMoveTarget(
  target: unknown,
  configured: ConfiguredMoveTargets,
): IssueTrackerMoveTarget {
  if (target === "backlog") return configured.backlog;
  if (target === "ai_review") return configured.aiReview;
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error("Update Ticket Status requires a non-empty status target.");
  }
  const statusId = target.trim();
  return { name: statusId, statusId };
}
