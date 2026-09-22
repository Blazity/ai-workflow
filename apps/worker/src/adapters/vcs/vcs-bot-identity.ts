import {
  AI_WORKFLOW_MARKER_PATTERN as SDK_AI_WORKFLOW_MARKER_PATTERN,
  selectReviewLedgerWorkItems,
} from "@integrations/sdk";
import type { VcsProviderKind } from "@shared/contracts";

const BOT_LOGIN_SUFFIX = "[bot]";

export interface VcsBotLoginConfig {
  byProvider: Readonly<Record<string, string | undefined>>;
  legacy?: string;
}

export function resolveVcsBotLogin(
  kind: VcsProviderKind,
  configuredProviders: readonly VcsProviderKind[],
  logins: VcsBotLoginConfig,
): string | undefined {
  const providerSpecific = normalizeVcsLogin(logins.byProvider[kind]);
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

/**
 * EVERY marker family this workflow writes into a pull request, not just the
 * bot marker above.
 *
 * `AI_WORKFLOW_COMMENT_MARKER` rides on what the workflow posts as a comment:
 * a run summary, an autofix exhaustion notice, a review-thread reply, the
 * review summary comment. It is NOT on what the review pass posts as review
 * content, which carries its own families instead:
 * `ai-workflow-review-finding:<digest>` on every inline finding
 * (`github.ts`, `gitlab.ts`), `ai-workflow-review-head:<sha>` on the review
 * submission that carries the round's verdict, `ai-workflow-review:<key>` on
 * the summary and `ai-workflow-review-comment:<key>:<index>` on the legacy
 * GitLab notes. `getPRComments` returns all of them, because it reads the
 * inline comments, the conversation and every review body.
 *
 * So a rule that knew only the bot marker called our own review findings a
 * person's words, on every pull request this workflow had ever reviewed, which
 * is the normal shape rather than an edge. One pattern over the whole family,
 * so a marker added tomorrow is ours without anybody remembering to come back
 * here; `vcs-bot-identity.test.ts` reads the adapters' own source and fails if
 * one is written that this does not match.
 */
// One pattern for core and for every provider package: the SDK owns it, the
// webhooks that decide whether a comment fires a trigger read it from there,
// and this file answers the same question about a comment already fetched.
const AI_WORKFLOW_MARKER_PATTERN = SDK_AI_WORKFLOW_MARKER_PATTERN;

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
 * Does this body carry the bot marker on a line its own author wrote?
 *
 * The question `blocks/post-pr-comment/execute.ts` asks before deciding
 * whether it still has to append one. A body that carries the marker only
 * inside a quote has not been marked at all, because everything downstream now
 * reads a quoted marker as somebody quoting us; appending one there is what
 * keeps "the workflow's comments never fire a trigger" true by construction
 * rather than by luck.
 */
export function hasUnquotedAiWorkflowCommentMarker(
  body: string | null | undefined,
): boolean {
  return typeof body === "string" && hasAiWorkflowCommentMarker(unquoted(body));
}

/**
 * Did this workflow write this pull request comment, judged from its body alone?
 *
 * Two questions at once, and both were once answered wrongly.
 *
 * WHICH MARKERS: every family in {@link AI_WORKFLOW_MARKER_PATTERN}, not the
 * bot marker alone. Our inline review findings and our review submission
 * bodies carry no bot marker, and `getPRComments` hands all of them back.
 *
 * WHOSE LINE: a line the author wrote, not one they quoted. "Quote reply"
 * copies the body it answers verbatim, marker included, with every line
 * blockquoted, so a reviewer quoting our "automated fix pushed" note to say the
 * button is still dead posts a comment carrying our marker. It is the same
 * thing {@link isReopenedLedgerThread} means by "a marker alone proves nothing:
 * anyone can quote our reply back at us"; the ledger can ask the provider who
 * authored a note, and a flat comment has no such answer to give.
 *
 * Safe by construction in the direction that matters: everything this workflow
 * posts carries one of these markers on a line of its own, and
 * `blocks/post-pr-comment/execute.ts` appends the bot marker whenever a body
 * has none unquoted, so one of ours cannot be read as a person's and stop a
 * finished run from closing. The reverse mistake, reading a person as us, is
 * the one that silences a reviewer, and quoting is the only realistic way to
 * cause it.
 *
 * One shape this still gets wrong, and the change that would end it: a person
 * who pastes one of our notes without blockquoting it reads as us. That is the
 * body standing in for authorship, and it disappears the day `PRComment`
 * carries an `isOurs` set where the comment is fetched, which is where the
 * provider already answers that question.
 */
export function isOurOwnPrComment(body: string | null | undefined): boolean {
  return typeof body === "string" && AI_WORKFLOW_MARKER_PATTERN.test(unquoted(body));
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
 * Which review threads the agent owes an answer is a statement about the
 * `ReviewThread` every provider produces, so the rule lives in the SDK beside
 * that type and is re-exported here, where core has always imported it from.
 * One rule, and a provider package can read it without reaching into core.
 */
export { isReviewLedgerWorkItem } from "@integrations/sdk";
export { selectReviewLedgerWorkItems };

/** Why a run does or does not owe somebody an answer on a pull request. Kept
 *  alongside the boolean because a person reading a run needs the reason more
 *  than the verdict: "it stopped" and "it stopped because every thread on the
 *  PR was already answered" are not the same message. */
type PendingReviewFeedbackReason =
  /** At least one review thread is still waiting on this workflow. */
  | "open_review_threads"
  /** Comments from somebody other than us on a PR with no thread feed. */
  | "unanswered_pr_comments"
  /** A feed was read and every thread in it is answered, parked or a third
   *  party bot's, so nothing in the review is ours to act on. */
  | "no_thread_awaits_an_answer"
  /** The only notes on the PR are this workflow's own bookkeeping. */
  | "only_our_own_notes"
  /** No pull request in this run carries any feedback at all. */
  | "no_pull_request_feedback";

export interface PendingReviewFeedback {
  pending: boolean;
  reason: PendingReviewFeedbackReason;
  /** The pull requests somebody is waiting on, as `provider:repoPath`, so a run
   *  that refuses to stop can say which one it means. Empty when nothing is
   *  pending, and empty when the caller passed contexts that carry no
   *  repository, which the prompt assemblers do not need. */
  repositories: string[];
}

/** Structural, like {@link selectReviewLedgerWorkItems}: this module stays free
 *  of adapters/vcs/types.ts so the workflow bundle never pulls node:crypto in
 *  behind it. */
export interface PendingReviewFeedbackContext {
  /** Only so a run can name the pull request in what it tells a person; the
   *  verdict never depends on it. */
  repository?: { provider: string; repoPath: string } | undefined;
  prComments: ReadonlyArray<{ body: string }>;
  reviewThreads?:
    | {
        threads: Array<{
          awaitingHuman: boolean;
          source: "human" | "bot" | "third_party";
          filePath?: string | undefined;
        }>;
      }
    | undefined;
}

/**
 * Does this run still owe a person an answer on a pull request?
 *
 * ONE predicate, because the prompt and the no-change gate are two readers of
 * the same question. They used to hold two expressions apiece with a comment
 * claiming they agreed, and a comment is not a mechanism: the prompt framed a
 * run as a remediation on one rule while the gate refused the already-resolved
 * exit on another.
 *
 * Answered per repository, and a thread feed wins wherever there is one. The
 * feed is the provider's complete statement of what is still unresolved:
 * inline threads, general comments and review summary boxes alike, already
 * split into what awaits us and what is only background. The flat comment list
 * is not that. It also carries resolved threads and every note this workflow
 * posted itself, so asking both together would answer "pending" forever on a PR
 * whose conversation is over. A repository with a feed therefore asks the feed
 * and nothing else; a repository without one asks the flat list with our own
 * notes taken out by {@link isOurOwnPrComment}, which is all the identity a
 * flat comment carries.
 *
 * Deliberately narrower than what the prompt RENDERS. An agent reads every note
 * on the PR, this workflow's own included, because that is context. Only what
 * somebody else is still waiting on is pending feedback.
 *
 * WHAT THIS CANNOT KNOW, so nobody has to rediscover it:
 *
 * - Whether the pull request is still open. A merged or closed one's comments
 *   still read as somebody waiting, because nothing in this system carries a
 *   pull request's liveness this far.
 * - Whether a comment on a feed-less repository came from a third party
 *   scanner bot. The feed knows (`source: "third_party"`); a flat `PRComment`
 *   carries no identity but its body, so CodeRabbit reads as a person there
 *   while the same account on a repository WITH a feed reads as a bot. One
 *   root, and the cure is an identity field set where each adapter already
 *   knows the viewer. It is not free: `adapters/vcs/github.test.ts` and
 *   `gitlab.test.ts` assert whole `PRComment` objects, so a new field, even an
 *   optional one, moves those assertions, and `getPRComments` would gain a
 *   viewer lookup on paths that make no such call today. It would also answer
 *   only "is this ours", not "is this a bot", which is the other half.
 * - A review submitted with an empty body and no inline comment. It reaches
 *   neither list, so no reader here can see it. Provider-shaped.
 * - A reaction. Emoji on a comment is not a comment; `PRComment.liked` records
 *   that one exists and nothing treats it as a request.
 */
export function resolvePendingReviewFeedback(
  contexts: readonly PendingReviewFeedbackContext[] | undefined,
): PendingReviewFeedback {
  const openThreadRepositories: string[] = [];
  const unansweredRepositories: string[] = [];
  let openThreads = 0;
  let unansweredComments = 0;
  let carriedThreads = 0;
  let ourOwnNotes = 0;
  for (const context of contexts ?? []) {
    const label = context.repository
      ? `${context.repository.provider}:${context.repository.repoPath}`
      : null;
    const feed = context.reviewThreads;
    // A feed carrying nothing supersedes nothing. `fetch-pr-context` leaves an
    // empty feed on the context even where it refuses to build a ledger from
    // it, and a review that opened no thread at all ("Request changes" with a
    // summary and nothing inline) is exactly that shape. Letting it speak for
    // the repository would silence the flat comments beside it, which is where
    // that review's words actually are.
    if (feed && feed.threads.length > 0) {
      carriedThreads += feed.threads.length;
      const workItems = selectReviewLedgerWorkItems(feed).length;
      openThreads += workItems;
      if (workItems > 0 && label) openThreadRepositories.push(label);
      continue;
    }
    const theirs = context.prComments.filter((comment) => !isOurOwnPrComment(comment.body));
    ourOwnNotes += context.prComments.length - theirs.length;
    unansweredComments += theirs.length;
    if (theirs.length > 0 && label) unansweredRepositories.push(label);
  }
  if (openThreads > 0) {
    return {
      pending: true,
      reason: "open_review_threads",
      repositories: openThreadRepositories,
    };
  }
  if (unansweredComments > 0) {
    return {
      pending: true,
      reason: "unanswered_pr_comments",
      repositories: unansweredRepositories,
    };
  }
  const reason: PendingReviewFeedbackReason =
    carriedThreads > 0
      ? "no_thread_awaits_an_answer"
      : ourOwnNotes > 0
        ? "only_our_own_notes"
        : "no_pull_request_feedback";
  return { pending: false, reason, repositories: [] };
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
  const last = notes.at(-1);
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
