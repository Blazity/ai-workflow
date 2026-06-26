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

export function normalizeDashboardRole(role: string): DashboardRole | null {
  const roles = role.split(",").map((part) => part.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  if (roles.includes("member")) return "member";
  return null;
}
