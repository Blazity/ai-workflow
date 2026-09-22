
export interface PRReviewInlineComment {
  path: string;
  body: string;
  startLine: number;
  endLine: number;
  startOldLine?: number | null;
  endOldLine?: number | null;
}

export const AI_WORKFLOW_COMMENT_MARKER = "<!-- ai-workflow:bot -->";

export function hasReviewLedgerFailureMarker(body: string, runId: string): boolean {
  return body.includes(`<!-- ai-workflow:ledger-failure:${runId} -->`);
}

export function reviewLedgerFailureMarker(runId: string): string {
  return `<!-- ai-workflow:ledger-failure:${runId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
}

export function readReviewLedgerMarker(body: string): string | null {
  return /<!-- ai-workflow:ledger:([^\s]+) -->/.exec(body)?.[1] ?? null;
}

export function readAnyReviewLedgerMarker(body: string): string | null {
  return /<!-- ai-workflow:ledger(?:-stale|-resolved)?:([^\s]+) -->/.exec(body)?.[1] ?? null;
}

export function isReviewLedgerNote(body: string): boolean {
  return /<!-- ai-workflow:ledger(?:-stale|-resolved|-failure)?:[^\s]+ -->/.test(body);
}

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

export function reviewFallbackBullet(comment: PRReviewInlineComment): string {
  const range =
    comment.startLine === comment.endLine
      ? String(comment.startLine)
      : `${comment.startLine}-${comment.endLine}`;
  const [first = "", ...rest] = comment.body.split("\n");
  const continuation = rest.map((line) => (line.trim() === "" ? "" : `  ${line}`));
  return [`- \`${comment.path}:${range}\` - ${first}`, ...continuation].join("\n");
}
