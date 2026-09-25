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

/** Changing a product-behaviour switch changes it for everyone, so the same
 *  owner/admin rule as every other deployment-wide mutation. Reading the
 *  settings page stays open to every member. */
export function canEditSettings(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Removing a stored setting hands the key back to whatever the environment or
 * the registry default answers with. Whoever may store a value may also remove
 * it (the product owner's decision of 2026-09-23), on the dashboard and through
 * MCP `settings.reset` alike: the worker's MCP policy lists the same roles, and
 * a test there holds the two equal.
 */
export function canResetSettings(role: DashboardRole): boolean {
  return canEditSettings(role);
}

/** Adding, editing, disabling or activating repositories decides what the
 *  agent may touch at all, so it follows the same rule, on the dashboard and
 *  through MCP alike: activation included since 2026-09-23. The worker's MCP
 *  policy lists the same roles for every catalog write, and a test there holds
 *  them equal. */
export function canManageRepositoryCatalog(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}

/** Connecting an integration means handing this deployment a customer's
 *  credential at a third party, and disabling one stops work everywhere, so the
 *  same owner/admin rule as every other deployment-wide mutation. Reading which
 *  integrations are connected stays open to every member: it carries no secret,
 *  and a member who cannot see it cannot tell a broken deployment from a quiet
 *  one. */
export function canManageIntegrations(role: DashboardRole): boolean {
  return role === "owner" || role === "admin";
}
