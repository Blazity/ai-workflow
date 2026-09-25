import type { VcsProviderKind } from "./domain";
import { repositoryCatalogKey } from "./repository-catalog";

/**
 * The subject key of one repository: where the worker keeps what runs learned
 * about it (`facts`, `lessons`) and how a screen finds those documents in the
 * memory listing.
 *
 * Spelled once, here, because it is an address compared exactly: a screen that
 * spelled it itself would find nothing the day either spelling changed, and
 * would say "nothing recorded yet" about a repository with memory. The worker
 * re-exports it (and `ticketSubjectKey` below) from
 * `engine/support/subject-key.ts` beside the other kinds.
 */
export function repoSubjectKey(provider: VcsProviderKind, repoPath: string): string {
  return `repo:${provider}:${repoPath}`;
}

/**
 * A ticket key in its one spelling: trimmed and uppercased, so `awp-235` and
 * `AWP-235` name one ticket. Every tracker's keys are compared this way: the
 * only tracker today is Jira, whose keys are `PROJECT-123` and which reads a
 * key in any case, and a tracker whose keys were case-sensitive would need its
 * own rule here before it could share a subject space with Jira.
 */
export function canonicalTicketKey(ticketKey: string): string {
  return ticketKey.trim().toUpperCase();
}

/**
 * The subject key of one ticket: the address its run's concurrency claim and
 * its work scope record are kept under, and how a screen finds that record.
 *
 * Spelled once, here, for the reason `repoSubjectKey` is: the dashboard reads
 * the record the worker writes, and two spellings drift apart silently. The
 * provider is the tracker's integration id, lowercased; the ticket key is
 * `canonicalTicketKey`'s spelling.
 */
export function ticketSubjectKey(ticketProvider: string, ticketKey: string): string {
  return `ticket:${ticketProvider.trim().toLowerCase()}:${canonicalTicketKey(ticketKey)}`;
}

/**
 * The subject key of one pull request: `pr:` plus the repository's identity
 * (`repositoryCatalogKey`, the path cased down) plus `#` and the number.
 *
 * The path is cased down because the same pull request reaches the worker
 * spelled two ways: a webhook carries the provider's spelling (`Blazity/x`),
 * a pasted URL the person's (`blazity/x`). Both providers resolve paths without
 * regard to case, so both name one pull request, and a key that kept each
 * caller's spelling gave it two subjects: two runs could work on it at once.
 * Rows stored before this spelling were rewritten by migration
 * 0073_pr_subject_key_normalize, whose SQL spells the same rule.
 */
export function prSubjectKey(
  provider: VcsProviderKind,
  repoPath: string,
  prNumber: number,
): string {
  return `pr:${repositoryCatalogKey({ provider, path: repoPath })}#${prNumber}`;
}

const PR_PREFIX = "pr:";
const TICKET_PREFIX = "ticket:";

/**
 * A subject key a person or an older record supplied, in the spelling the
 * builders above produce today: a pull request's path cased down, a ticket's
 * tracker lowercased and its key uppercased. Every other kind is returned as it
 * came, case included, because its builder keeps the case it was given.
 *
 * For keys that arrive from outside a builder: an MCP tool or an HTTP route
 * that takes a subject key. Without it, `ticket:jira:awp-281` addressed an
 * empty twin of `ticket:jira:AWP-281`, and an edit of it answered success on a
 * record no run reads. A key with no provider separator is returned untouched:
 * no builder ever wrote one, so there is no spelling to restore.
 */
export function canonicalSubjectKey(subjectKey: string): string {
  const key = subjectKey.trim();
  if (key.startsWith(PR_PREFIX)) {
    const separator = key.indexOf(":", PR_PREFIX.length);
    if (separator < 0) return key;
    return `${key.slice(0, separator + 1)}${key.slice(separator + 1).toLowerCase()}`;
  }
  if (key.startsWith(TICKET_PREFIX)) {
    const separator = key.indexOf(":", TICKET_PREFIX.length);
    if (separator < 0) return key;
    return ticketSubjectKey(key.slice(TICKET_PREFIX.length, separator), key.slice(separator + 1));
  }
  return key;
}
