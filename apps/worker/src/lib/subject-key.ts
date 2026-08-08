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

/**
 * Concurrency identity of one webhook delivery. The second component is the
 * external subject id when the endpoint's subjectPath resolves one (so repeat
 * deliveries about the same ticket queue behind each other) and the delivery id
 * otherwise (so every delivery gets its own subject).
 *
 * The result is a subject key only. It is not a branch name, a ref, or a ticket
 * identifier: the sender controls the subject id, so anything derived from this
 * for git or an external system must be sanitized where it is derived.
 */
export function webhookSubjectKey(endpointId: string, subjectId: string): string {
  return `webhook:${endpointId.trim()}:${subjectId.trim()}`;
}

/**
 * Concurrency identity of one schedule occurrence, and the ONLY thing the
 * overlap policy changes.
 *
 * Omit the occurrence and every occurrence of the schedule competes for one
 * subject, which is what makes "skip" skip and "queue" queue: the second one
 * finds the subject claimed. Pass the occurrence and each one gets a subject of
 * its own, so runs are independent, which is what "allow" means.
 *
 * The occurrence component is epoch milliseconds rather than an ISO instant
 * because this key is compared as an opaque string: two spellings of the same
 * instant would be two subjects, and a run would overlap itself.
 */
export function scheduleSubjectKey(
  scheduleId: string,
  occurrenceAt?: Date,
): string {
  const base = `schedule:${scheduleId.trim()}`;
  return occurrenceAt === undefined ? base : `${base}:${occurrenceAt.getTime()}`;
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
