import type { IssueTrackerQueryRule } from "@integrations/sdk";

/**
 * Validates queries authored for Linear, warning authors that Linear
 * relies on keywords rather than a text-based query syntax like JQL.
 */
export function linearQueryProblem(query: string): string | null {
  if (query.trim() === "") return null;
  return (
    "Linear does not have a text-based query language like JQL. " +
    "Leave the query empty so the search uses the ticket's keywords."
  );
}

/**
 * The issue tracker query rule for Linear.
 */
export const linearQueryRule: IssueTrackerQueryRule = {
  problem: linearQueryProblem,
};
