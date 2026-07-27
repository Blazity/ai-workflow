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
