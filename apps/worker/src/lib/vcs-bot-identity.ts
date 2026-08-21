import type { VcsProviderKind } from "@shared/contracts";

const BOT_LOGIN_SUFFIX = "[bot]";

export interface VcsBotLoginConfig {
  github?: string;
  gitlab?: string;
  legacy?: string;
}

export function resolveVcsBotLogin(
  kind: VcsProviderKind,
  configuredProviders: readonly VcsProviderKind[],
  logins: VcsBotLoginConfig,
): string | undefined {
  const providerSpecific = normalizeVcsLogin(
    kind === "github" ? logins.github : logins.gitlab,
  );
  if (providerSpecific) return providerSpecific;
  return configuredProviders.length === 1 && configuredProviders[0] === kind
    ? normalizeVcsLogin(logins.legacy)
    : undefined;
}

export function vcsLoginsMatch(
  producer: string | null | undefined,
  configuredBot: string | null | undefined,
): boolean {
  const normalizedProducer = normalizeVcsLogin(producer);
  const normalizedBot = normalizeVcsLogin(configuredBot);
  return normalizedProducer !== undefined && normalizedProducer === normalizedBot;
}

export function normalizeVcsLogin(login: string | null | undefined): string | undefined {
  const lowercased = login?.trim().toLowerCase();
  if (!lowercased) return undefined;
  const stripped = lowercased.endsWith(BOT_LOGIN_SUFFIX)
    ? lowercased.slice(0, -BOT_LOGIN_SUFFIX.length)
    : lowercased;
  return stripped ? stripped : undefined;
}

export const AI_WORKFLOW_COMMENT_MARKER = "<!-- ai-workflow:bot -->";

export function hasAiWorkflowCommentMarker(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(AI_WORKFLOW_COMMENT_MARKER);
}

// Review ledger markers. Every ledger marker also carries AI_WORKFLOW_COMMENT_MARKER
// so a ledger reply is recognized by the existing echo filter without a second check.

export function reviewLedgerMarker(threadId: string): string {
  return `<!-- ai-workflow:ledger:${threadId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
}

export function readReviewLedgerMarker(body: string): string | null {
  return /<!-- ai-workflow:ledger:([^\s]+) -->/.exec(body)?.[1] ?? null;
}

export function reviewLedgerFailureMarker(runId: string): string {
  return `<!-- ai-workflow:ledger-failure:${runId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
}

export function hasReviewLedgerFailureMarker(body: string, runId: string): boolean {
  return body.includes(`<!-- ai-workflow:ledger-failure:${runId} -->`);
}
