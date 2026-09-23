import type { VcsProviderKind } from "./domain";

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
 * The subject key of one ticket: the address its run's concurrency claim and
 * its work scope record are kept under, and how a screen finds that record.
 *
 * Spelled once, here, for the reason `repoSubjectKey` is: the dashboard reads
 * the record the worker writes, and two spellings drift apart silently. The
 * provider is the tracker's integration id, lowercased; the ticket key is
 * uppercased, so `awp-235` and `AWP-235` are one subject.
 */
export function ticketSubjectKey(ticketProvider: string, ticketKey: string): string {
  return `ticket:${ticketProvider.trim().toLowerCase()}:${ticketKey.trim().toUpperCase()}`;
}
