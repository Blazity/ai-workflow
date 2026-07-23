export const BRANCH_PREFIX = "ai-workflow/";
export const LEGACY_BRANCH_PREFIX = "blazebot/";

export const GATE_CHECK_NAME_PREFIX = "AI Workflow / ";
export const LEGACY_GATE_CHECK_NAME_PREFIX = "blazebot / ";

const MANAGED_BRANCH_PREFIXES = [
  BRANCH_PREFIX,
  LEGACY_BRANCH_PREFIX,
] as const;

const MANAGED_GATE_CHECK_PREFIXES = [
  GATE_CHECK_NAME_PREFIX,
  LEGACY_GATE_CHECK_NAME_PREFIX,
] as const;

/** New workflow-owned branches always use the current product namespace. */
export function branchForTicket(ticketIdentifier: string): string {
  return `${BRANCH_PREFIX}${ticketIdentifier.toLowerCase()}`;
}

/** Both namespaces remain recognizable so historical branches keep working. */
export function isManagedBranch(branch: string): boolean {
  return MANAGED_BRANCH_PREFIXES.some(
    (prefix) =>
      branch.startsWith(prefix) && branch.length > prefix.length,
  );
}

export function ticketKeyFromBranch(branch: string): string | null {
  const prefix = MANAGED_BRANCH_PREFIXES.find((candidate) =>
    branch.startsWith(candidate),
  );
  if (!prefix) return null;
  const suffix = branch.slice(prefix.length);
  return suffix ? suffix.toUpperCase() : null;
}

/** New provider checks/statuses always use the current product namespace. */
export function gateCheckName(name: string): string {
  return `${GATE_CHECK_NAME_PREFIX}${gateCheckSuffix(name)}`;
}

/** Exact aliases used when a provider event must recognize either generation. */
export function gateCheckNameAliases(name: string): [string, string] {
  const suffix = gateCheckSuffix(name);
  return [
    `${GATE_CHECK_NAME_PREFIX}${suffix}`,
    `${LEGACY_GATE_CHECK_NAME_PREFIX}${suffix}`,
  ];
}

/** Suppresses recursive handling for both new and historical managed checks. */
export function isManagedGateCheckName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    MANAGED_GATE_CHECK_PREFIXES.some(
      (prefix) => name.startsWith(prefix) && name.length > prefix.length,
    )
  );
}

function gateCheckSuffix(name: string): string {
  const prefix = MANAGED_GATE_CHECK_PREFIXES.find((candidate) =>
    name.startsWith(candidate),
  );
  return prefix ? name.slice(prefix.length) : name;
}
