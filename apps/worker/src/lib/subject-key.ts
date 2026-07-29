import type { VcsProviderKind } from "../../env.js";

export function ticketSubjectKey(ticketProvider: string, ticketKey: string): string {
  return `ticket:${ticketProvider.trim().toLowerCase()}:${ticketKey.trim().toUpperCase()}`;
}

export function prSubjectKey(
  provider: VcsProviderKind,
  repoPath: string,
  prNumber: number,
): string {
  return `pr:${provider}:${repoPath}#${prNumber}`;
}

export function repoSubjectKey(provider: VcsProviderKind, repoPath: string): string {
  return `repo:${provider}:${repoPath}`;
}

export function orgSubjectKey(provider: VcsProviderKind, owner: string): string {
  return `org:${provider}:${owner}`;
}

/**
 * The owner a repository path belongs to, which is what groups repositories that
 * share knowledge. Only the first segment counts: a GitLab subgroup path
 * ("acme/group/project") belongs to the same top-level owner as "acme/service",
 * so grouping on anything deeper would split one organization into several.
 * Null when the path carries no owner, which is never promoted or read.
 */
export function repoOwner(repoPath: string): string | null {
  const separator = repoPath.indexOf("/");
  // -1 is "no slash at all" and 0 is "the owner segment is empty"; neither
  // names an owner.
  if (separator <= 0) return null;
  return repoPath.slice(0, separator);
}
