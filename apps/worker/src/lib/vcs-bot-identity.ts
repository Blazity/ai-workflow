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

/**
 * The variant a settler posts when a person wrote in the thread after the feed
 * snapshot. It still carries the bot marker (without it the reply would fire
 * `trigger_pr_review` and the ledger would answer itself), but it deliberately
 * does not park the thread on a human: the person's newest words have not been
 * answered yet, so the thread has to come back as a work item next run.
 */
function reviewLedgerStaleMarker(threadId: string): string {
  return `<!-- ai-workflow:ledger-stale:${threadId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
}

/**
 * The variant a settler posts when it also resolves the thread. A resolved
 * thread is out of the feed entirely, so the only way one comes back is a person
 * reopening it: this marker deliberately does not park the thread on a human, so
 * the reopened thread returns as a work item instead of waiting for a comment
 * that has already been made in the form of the reopen itself.
 */
function reviewLedgerResolvedMarker(threadId: string): string {
  return `<!-- ai-workflow:ledger-resolved:${threadId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
}

/** Ledger replies that park the thread on a human. The stale and resolved
 * variants are excluded on purpose; see {@link reviewLedgerStaleMarker} and
 * {@link reviewLedgerResolvedMarker}. */
export function readReviewLedgerMarker(body: string): string | null {
  return /<!-- ai-workflow:ledger:([^\s]+) -->/.exec(body)?.[1] ?? null;
}

/**
 * Any of the three reply variants. This is the idempotency key: a settler must
 * recognise its own previous reply whichever marker it carried, or a second
 * settle pass posts the same answer twice.
 */
export function readAnyReviewLedgerMarker(body: string): string | null {
  return /<!-- ai-workflow:ledger(?:-stale|-resolved)?:([^\s]+) -->/.exec(body)?.[1] ?? null;
}

/**
 * Anything this workflow wrote as ledger bookkeeping: a reply in any of its
 * three variants, or a run failure note. This is the feed filter's question,
 * which is not the settler's: a failure note is keyed by run id and matches no
 * thread, so an id comparison would let it back in as a work item and the next
 * run would answer our own apology.
 */
/**
 * Is this thread the agent's to answer? Three kinds of thread are carried as
 * background instead:
 *
 * - one already answered by us, which is waiting on a person, not on the agent;
 * - one opened by a third-party reviewer, which the ledger never replies to;
 * - one of our own general notes ("automated fix pushed", a run summary), which
 *   is bookkeeping rather than review feedback. Our own *inline* thread is a
 *   real finding from the review pass and stays work.
 *
 * Lives here rather than next to the ReviewThread type: adapters/vcs/types.ts
 * imports node:crypto, and this predicate is also needed by the workflow
 * bundle, where Node modules are refused at build time.
 */
export function isReviewLedgerWorkItem(thread: {
  awaitingHuman: boolean;
  source: "human" | "bot" | "third_party";
  filePath?: string | undefined;
}): boolean {
  if (thread.awaitingHuman) return false;
  if (thread.source === "third_party") return false;
  return !(thread.source === "bot" && thread.filePath === undefined);
}

export function isReviewLedgerNote(body: string): boolean {
  return /<!-- ai-workflow:ledger(?:-stale|-resolved|-failure)?:[^\s]+ -->/.test(body);
}

/** Swap the composed reply's marker for the stale variant. Appends one when the
 * body carries no marker at all, so a reply can never reach a PR unmarked. */
export function markReviewLedgerReplyStale(body: string, threadId: string): string {
  return swapReviewLedgerMarker(body, threadId, reviewLedgerStaleMarker(threadId));
}

/** Swap the composed reply's marker for the resolved variant; see
 * {@link reviewLedgerResolvedMarker}. */
export function markReviewLedgerReplyResolved(body: string, threadId: string): string {
  return swapReviewLedgerMarker(body, threadId, reviewLedgerResolvedMarker(threadId));
}

function swapReviewLedgerMarker(body: string, threadId: string, marker: string): string {
  const plain = reviewLedgerMarker(threadId);
  return body.includes(plain) ? body.replace(plain, marker) : `${body}\n\n${marker}`;
}

/** The shape both adapters carry a thread's notes in; see ReviewThreadNote. */
type LedgerNoteLike = { author: string; body: string; createdAt: string };

/**
 * Did a person write in this thread after our reply parked it? The reply carries
 * one of our markers, so the pair "our marker note, then a newer note that is not
 * ours" is the only shape a reopened thread can have.
 *
 * `isOurs` is the caller's own answer to authorship (GitLab compares the token's
 * username, GitHub asks the provider via `viewerDidAuthor`), because a marker
 * alone proves nothing: anyone can quote our reply back at us.
 */
export function isReopenedLedgerThread<T extends LedgerNoteLike>(
  notes: readonly T[],
  isOurs: (note: T) => boolean,
): boolean {
  const last = notes[notes.length - 1];
  if (last === undefined || isOurs(last)) return false;
  const ourMarker = notes.find(
    (note) => readAnyReviewLedgerMarker(note.body) !== null && isOurs(note),
  );
  return ourMarker !== undefined && last.createdAt > ourMarker.createdAt;
}

export function reviewLedgerFailureMarker(runId: string): string {
  return `<!-- ai-workflow:ledger-failure:${runId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
}

export function hasReviewLedgerFailureMarker(body: string, runId: string): boolean {
  return body.includes(`<!-- ai-workflow:ledger-failure:${runId} -->`);
}
