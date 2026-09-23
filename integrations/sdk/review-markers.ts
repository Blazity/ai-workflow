/**
 * Every comment marker this workflow writes into a pull request or a merge
 * request, and every reader of one: one grammar, one home.
 *
 * Every string built here identifies a comment already posted on somebody's
 * pull request, so the values are frozen: a marker written by an older build
 * must still read, and `review-markers.test.ts` holds the literals `main`
 * wrote before providers moved into packages. The GitHub and GitLab packages
 * and core each kept a copy of this grammar until the copies began to differ;
 * a provider now builds and reads its markers here, and core re-exports them
 * from `adapters/vcs/vcs-bot-identity.ts`.
 *
 * Four families, all matched by {@link AI_WORKFLOW_MARKER_PATTERN}:
 *
 * - the bot marker, on every comment the workflow posts as a comment (a run
 *   summary, an autofix notice, a review thread reply, the review summary);
 * - the review ledger's replies and run failure notes, which also carry the
 *   bot marker;
 * - the review round's own markers (its summary, the review that carries its
 *   verdict, one per inline finding), which carry no bot marker at all;
 * - GitLab's review comment marker from before findings had an identity,
 *   never written again and still recognised.
 *
 * The finding digest a finding marker carries is derived by core
 * (`reviewFindingDigest` in the worker, which needs `node:crypto`); a
 * provider only writes it and reads it back.
 */

/**
 * EVERY marker family this workflow writes, in one pattern, so a marker added
 * tomorrow is ours without anybody remembering to come back here.
 *
 * The bot marker is not enough on its own: review findings and review
 * submissions carry their own families and no bot marker at all, and a rule
 * that knew only the bot marker read our own findings as a person's words.
 */
export const AI_WORKFLOW_MARKER_PATTERN = /<!--\s*ai-workflow[:-][^>]*-->/;

export const AI_WORKFLOW_COMMENT_MARKER = "<!-- ai-workflow:bot -->";

/** What the author of a comment actually wrote: every line they quoted, gone.
 *  Markdown allows up to three spaces before the `>`, and a nested quote opens
 *  with one too. */
function unquoted(body: string): string {
  return body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/**
 * Did this workflow write this comment, judged from its body alone?
 *
 * WHICH MARKERS: every family in {@link AI_WORKFLOW_MARKER_PATTERN}, not the
 * bot marker alone. Our inline review findings and our review submission
 * bodies carry no bot marker, and a provider's comment listing hands all of
 * them back.
 *
 * WHOSE LINE: a line the author wrote, not one they quoted. "Quote reply"
 * copies the body it answers verbatim, marker included, with every line
 * blockquoted, so a reviewer quoting our "automated fix pushed" note to say
 * the button is still dead posts a comment carrying our marker. Reading that
 * as ours starts no run at all, and their request goes nowhere with nothing
 * for anybody to look at.
 *
 * Safe by construction in the direction that matters: everything this
 * workflow posts carries one of these markers on a line of its own, and core's
 * `post_pr_comment` appends the bot marker whenever a body has none unquoted,
 * so one of ours cannot be read as a person's. The reverse mistake, reading a
 * person as us, is the one that silences a reviewer.
 *
 * One shape this still gets wrong: a person who pastes one of our notes
 * without blockquoting it reads as us. That is the body standing in for
 * authorship, and it disappears the day a fetched comment carries whether the
 * provider says the token wrote it.
 */
export function isOurOwnVcsComment(body: unknown): boolean {
  return typeof body === "string" && AI_WORKFLOW_MARKER_PATTERN.test(unquoted(body));
}

export function hasAiWorkflowCommentMarker(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(AI_WORKFLOW_COMMENT_MARKER);
}

/**
 * Does this body carry the bot marker on a line its own author wrote?
 *
 * The question core's `post_pr_comment` asks before deciding whether it still
 * has to append one. A body that carries the marker only inside a quote has
 * not been marked at all, because everything downstream reads a quoted marker
 * as somebody quoting us; appending one there is what keeps "the workflow's
 * comments never fire a trigger" true by construction rather than by luck.
 * Narrower than {@link isOurOwnVcsComment} on purpose: the bot marker is the
 * one the trigger rules fall back to when a bot login is misconfigured, so a
 * review finding's marker must not stand in for it.
 */
export function hasUnquotedAiWorkflowCommentMarker(body: string | null | undefined): boolean {
  return typeof body === "string" && hasAiWorkflowCommentMarker(unquoted(body));
}

// ---------------------------------------------------------------------------
// The review ledger. Every ledger marker also carries the bot marker, so a
// ledger reply is recognised by the echo filter without a second check.

/** The reply that parks a thread on a human. */
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

/**
 * Did a person write in this thread after our reply parked it? The reply carries
 * one of our markers, so the pair "our marker note, then a newer note that is not
 * ours" is the only shape a reopened thread can have.
 *
 * `isOurs` is the caller's own answer to authorship (GitLab compares the token's
 * username, GitHub asks the provider via `viewerDidAuthor`), because a marker
 * alone proves nothing: anyone can quote our reply back at us.
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

/** The note a run posts when it failed to settle a pull request's threads. */
export function reviewLedgerFailureMarker(runId: string): string {
  return `<!-- ai-workflow:ledger-failure:${runId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
}

export function hasReviewLedgerFailureMarker(body: string, runId: string): boolean {
  return body.includes(`<!-- ai-workflow:ledger-failure:${runId} -->`);
}

// ---------------------------------------------------------------------------
// The review round. These carry no bot marker: they ride on review content,
// which a provider hands back beside every other comment, and are recognised
// as ours by the pattern above.

/** On the one summary comment a pull request carries, rewritten every round. */
export function reviewSummaryMarker(idempotencyKey: string): string {
  return `<!-- ai-workflow-review:${idempotencyKey} -->`;
}

/** On what carries a round's verdict (GitHub's review, GitLab's summary note),
 *  so a retry at the same head submits one verdict and not two. */
export function reviewHeadMarker(headSha: string): string {
  return `<!-- ai-workflow-review-head:${headSha} -->`;
}

/** On every inline finding: the thread a later round recognises it by. */
export function reviewFindingMarker(digest: string): string {
  return `<!-- ai-workflow-review-finding:${digest} -->`;
}

/** The digest a finding marker carries, if this body has one. */
export function readReviewFindingDigest(body: string): string | null {
  return /<!-- ai-workflow-review-finding:([0-9a-f]+) -->/.exec(body)?.[1] ?? null;
}

/**
 * GitLab's inline review note from before findings had an identity of their
 * own: the round's key and the finding's index in it. Never written again,
 * still recognised, because within one round the index does identify the
 * finding and an attempt that failed after posting must not post twice.
 */
export function legacyReviewCommentMarker(idempotencyKey: string, index: number): string {
  return `<!-- ai-workflow-review-comment:${idempotencyKey}:${index} -->`;
}
