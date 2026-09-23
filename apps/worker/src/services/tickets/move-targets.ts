import type { IssueTrackerMoveTarget } from "../../adapters/issue-tracker/types.js";

/**
 * Move target for the AI column: the transition the tracker's connection names
 * when the board has one, and the plain column name otherwise. Some boards can
 * only change a status through a named transition, and the id for it is part
 * of how the tracker is wired rather than something core can work out.
 */
export function aiColumnMoveTarget(input: {
  COLUMN_AI: string;
  aiTransitionId?: string;
}): IssueTrackerMoveTarget {
  return input.aiTransitionId
    ? { name: input.COLUMN_AI, transitionId: input.aiTransitionId }
    : input.COLUMN_AI;
}
