export const BRANCH_PREFIX = "blazebot/";

export function branchForTicket(ticketIdentifier: string): string {
  return `${BRANCH_PREFIX}${ticketIdentifier.toLowerCase()}`;
}

/** Reverse mapping. Returns null when the branch is not a Blazebot branch. */
export function ticketKeyFromBranch(branch: string): string | null {
  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  const suffix = branch.slice(BRANCH_PREFIX.length);
  if (!suffix) return null;
  return suffix.toUpperCase();
}
