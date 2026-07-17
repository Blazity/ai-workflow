import type { IssueTrackerMoveTarget } from "../adapters/issue-tracker/types.js";

/**
 * Move target for the AI column. Mirrors the inline backlogMoveTarget in
 * agent.ts: prefer an explicit workflow transition id when one is configured
 * (some Jira boards require a specific transition to change status), otherwise
 * fall back to the plain status name.
 */
export function aiColumnMoveTarget(input: {
  COLUMN_AI: string;
  JIRA_AI_TRANSITION_ID?: string;
}): IssueTrackerMoveTarget {
  return input.JIRA_AI_TRANSITION_ID
    ? { name: input.COLUMN_AI, transitionId: input.JIRA_AI_TRANSITION_ID }
    : input.COLUMN_AI;
}
