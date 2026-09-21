/**
 * The comment markers and the review finding digest this integration writes and
 * reads back on live pull requests.
 *
 * Copied into the package rather than imported from core (ADR-010): every
 * string here identifies a comment that is already posted on somebody's pull
 * request, so the values are frozen, not refactored. The digest formula is
 * shared with GitLab by value, never by module: each adapter reads only what it
 * wrote, and a digest that drifted between the two would strand every open
 * thread the other provider opened.
 */
import { createHash } from "node:crypto";
import type { ReviewThread } from "@integrations/sdk";

export interface PRReviewInlineComment {
  path: string;
  body: string;
  startLine: number;
  endLine: number;
  startOldLine?: number | null;
  endOldLine?: number | null;
}

const BOT_LOGIN_SUFFIX = "[bot]";

function normalizeVcsLogin(login: string | null | undefined): string | undefined {
  const lowercased = login?.trim().toLowerCase();
  if (!lowercased) return undefined;
  const stripped = lowercased.endsWith(BOT_LOGIN_SUFFIX)
    ? lowercased.slice(0, -BOT_LOGIN_SUFFIX.length)
    : lowercased;
  return stripped ? stripped : undefined;
}

/** Same login, allowing for the `[bot]` suffix GitHub appends to an App's user. */
export function vcsLoginsMatch(
  producer: string | null | undefined,
  configuredBot: string | null | undefined,
): boolean {
  const normalizedProducer = normalizeVcsLogin(producer);
  const normalizedBot = normalizeVcsLogin(configuredBot);
  return normalizedProducer !== undefined && normalizedProducer === normalizedBot;
}

export const AI_WORKFLOW_COMMENT_MARKER = "<!-- ai-workflow:bot -->";

export function hasReviewLedgerFailureMarker(body: string, runId: string): boolean {
  return body.includes(`<!-- ai-workflow:ledger-failure:${runId} -->`);
}

export function reviewLedgerFailureMarker(runId: string): string {
  return `<!-- ai-workflow:ledger-failure:${runId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
}

/** Ledger replies that park the thread on a human. The stale and resolved
 * variants are excluded on purpose: neither has been answered by a person yet. */
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

/** Anything this workflow wrote as ledger bookkeeping, a run failure note
 * included: the feed filter's question, which is not the settler's. */
export function isReviewLedgerNote(body: string): boolean {
  return /<!-- ai-workflow:ledger(?:-stale|-resolved|-failure)?:[^\s]+ -->/.test(body);
}

/**
 * Is this thread the agent's to answer? A thread already answered by us waits on
 * a person, a third party's thread is never replied to, and our own general note
 * is bookkeeping. Our own inline thread is a real finding and stays work.
 */
export function isReviewLedgerWorkItem(
  thread: Pick<ReviewThread, "awaitingHuman" | "source" | "filePath">,
): boolean {
  if (thread.awaitingHuman || thread.source === "third_party") return false;
  return !(thread.source === "bot" && thread.filePath === undefined);
}

/**
 * Did a person write in this thread after our reply parked it? `isOurs` is the
 * caller's own answer to authorship (GitHub asks the provider via
 * `viewerDidAuthor`), because a marker alone proves nothing: anyone can quote
 * our reply back at us.
 */
export function isReopenedLedgerThread<T extends { body: string; createdAt: string }>(
  notes: readonly T[],
  isOurs: (note: T) => boolean,
): boolean {
  const last = notes.at(-1);
  if (last === undefined || isOurs(last)) return false;
  const ourMarker = notes.find(
    (note) => readAnyReviewLedgerMarker(note.body) !== null && isOurs(note),
  );
  return ourMarker !== undefined && last.createdAt > ourMarker.createdAt;
}

export function markReviewLedgerReplyStale(body: string, threadId: string): string {
  return swapMarker(
    body,
    threadId,
    `<!-- ai-workflow:ledger-stale:${threadId} --> ${AI_WORKFLOW_COMMENT_MARKER}`,
  );
}

export function markReviewLedgerReplyResolved(body: string, threadId: string): string {
  return swapMarker(
    body,
    threadId,
    `<!-- ai-workflow:ledger-resolved:${threadId} --> ${AI_WORKFLOW_COMMENT_MARKER}`,
  );
}

function swapMarker(body: string, threadId: string, replacement: string): string {
  const plain = `<!-- ai-workflow:ledger:${threadId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
  return body.includes(plain) ? body.replace(plain, replacement) : `${body}\n\n${replacement}`;
}

export function readReviewFindingDigest(body: string): string | null {
  return /<!-- ai-workflow-review-finding:([0-9a-f]+) -->/.exec(body)?.[1] ?? null;
}

/**
 * The identity of one finding's THREAD: path and prose only, no line numbers and
 * no head commit, so a finding that survives a push keeps its thread instead of
 * opening an identical one beside it.
 */
export function reviewFindingDigest(
  comment: Pick<PRReviewInlineComment, "path" | "body">,
): string {
  return createHash("sha256")
    .update(`${comment.path} ${comment.body}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Renders one finding as a markdown list item, for the list a provider falls
 * back to when it refuses an inline position.
 *
 * Continuation lines are indented into the item deliberately: an unindented
 * blank line closes a markdown list, so a merged comment's agreement note would
 * detach and every finding after it would start a fresh list.
 */
export function reviewFallbackBullet(comment: PRReviewInlineComment): string {
  const range =
    comment.startLine === comment.endLine
      ? String(comment.startLine)
      : `${comment.startLine}-${comment.endLine}`;
  const [first = "", ...rest] = comment.body.split("\n");
  const continuation = rest.map((line) => (line.trim() === "" ? "" : `  ${line}`));
  return [`- \`${comment.path}:${range}\` - ${first}`, ...continuation].join("\n");
}
