import type { VcsProviderKind } from "./domain";

/**
 * The subject key of one repository: where the worker keeps what runs learned
 * about it (`facts`, `lessons`) and how a screen finds those documents in the
 * memory listing.
 *
 * Spelled once, here, because it is an address compared exactly: a screen that
 * spelled it itself would find nothing the day either spelling changed, and
 * would say "nothing recorded yet" about a repository with memory. The worker
 * re-exports it from `engine/support/subject-key.ts` beside the other kinds.
 */
export function repoSubjectKey(provider: VcsProviderKind, repoPath: string): string {
  return `repo:${provider}:${repoPath}`;
}
