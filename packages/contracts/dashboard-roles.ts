/**
 * The dashboard's role vocabulary, and what each role may do.
 *
 * It lives in the shared contracts package rather than in one worker cluster
 * because more than one of them decides on a role: the dashboard session path
 * reads it from a membership row, and the MCP actor path reads the same row to
 * decide what a token may do. Two copies of "which strings mean admin" is the
 * one shape this must never take.
 */
export type DashboardRole = "owner" | "admin" | "member";

export function canInvite(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

export function canChangeRole(input: {
  actor: DashboardRole;
  target: DashboardRole;
  next: DashboardRole;
}): boolean {
  if (input.actor !== "owner") return false;
  if (input.target === "owner" || input.next === "owner") return false;
  return input.next === "admin" || input.next === "member";
}

/**
 * The stored membership role, normalized. Better Auth stores a comma-separated
 * list, so the strongest role present wins; an unrecognized value is null, which
 * every caller treats as "no access" rather than as a default.
 */
export function normalizeDashboardRole(role: string): DashboardRole | null {
  const roles = new Set(role.split(",").map((part) => part.trim()));
  if (roles.has("owner")) return "owner";
  if (roles.has("admin")) return "admin";
  if (roles.has("member")) return "member";
  return null;
}

export function canEditPrePrChecks(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

export function canEditWorkflowDefinitions(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

export function canDispatchWorkflowRuns(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

export function canApproveWorkflowPlans(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

export function canEditPromptLibrary(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

export function canManageHarnessProfiles(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

/** Reading agent memory is open to every member; erasing it is a hard delete
 *  nobody can undo, so it follows the same owner/admin rule as every other
 *  cockpit mutation. */
export function canDeleteAgentMemory(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}
