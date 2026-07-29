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
 * The namespace that OWNS the repository, which is what groups repositories
 * that share knowledge: the whole path minus its last segment. "acme/service"
 * gives "acme" and the nested GitLab path "acme/group/project" gives
 * "acme/group".
 *
 * The first segment was the wrong rule. On GitHub it happens to be the
 * organization, so it is tenant-aligned there, but on a self-hosted GitLab one
 * top-level group routinely holds a subgroup per customer. Grouping on the
 * first segment there puts every customer under that group into one org memory
 * document, silently, with no per-tenant inspection and no deletion path. The
 * owning namespace is tenant-aligned on both forges.
 *
 * Null when the path carries no owner, which is never promoted or read.
 */
export function repoOwner(repoPath: string): string | null {
  const separator = repoPath.lastIndexOf("/");
  // -1 is "no slash at all" and 0 is "the owning namespace is empty"; neither
  // names an owner.
  if (separator <= 0) return null;
  return repoPath.slice(0, separator);
}
