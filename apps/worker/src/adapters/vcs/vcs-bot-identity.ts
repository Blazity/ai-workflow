import {
  isOurOwnVcsComment,
  normalizeVcsLogin,
  selectReviewLedgerWorkItems,
} from "@integrations/sdk";
import type { VcsProviderKind } from "@shared/contracts";

/**
 * Core's side of "who wrote this": which login is this deployment's automation
 * account, and whether a run still owes a person an answer.
 *
 * The rules a provider shares with core live in the SDK and are re-exported
 * here, where core has always imported them from: the comment marker grammar
 * (`integrations/sdk/review-markers.ts`), how two logins compare
 * (`vcsLoginsMatch`), and which review threads the agent owes an answer
 * (`isReviewLedgerWorkItem`). This module stays free of `adapters/vcs/types.ts`
 * so the workflow bundle never pulls `node:crypto` in behind it.
 */
export {
  AI_WORKFLOW_COMMENT_MARKER,
  hasAiWorkflowCommentMarker,
  hasReviewLedgerFailureMarker,
  hasUnquotedAiWorkflowCommentMarker,
  isOurOwnVcsComment,
  isReopenedLedgerThread,
  isReviewLedgerNote,
  isReviewLedgerWorkItem,
  markReviewLedgerReplyResolved,
  markReviewLedgerReplyStale,
  normalizeVcsLogin,
  readAnyReviewLedgerMarker,
  readReviewLedgerMarker,
  reviewLedgerFailureMarker,
  reviewLedgerMarker,
  selectReviewLedgerWorkItems,
  vcsLoginsMatch,
} from "@integrations/sdk";

export interface VcsBotLoginConfig {
  byProvider: Readonly<Record<string, string | undefined>>;
  legacy?: string;
}

/**
 * The automation account of `kind`: its own login, or the legacy
 * single-provider login when `kind` is the deployment's only version control
 * provider (`VCS_LEGACY_BOT_LOGIN_FIELD` in the SDK says why).
 */
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
 * notes taken out by {@link isOurOwnVcsComment}, which is all the identity a
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
    const theirs = context.prComments.filter((comment) => !isOurOwnVcsComment(comment.body));
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
