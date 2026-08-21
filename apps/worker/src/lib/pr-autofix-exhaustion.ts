import type { VcsProviderKind } from "@shared/contracts";
import { createAdapters } from "./adapters.js";
import { logger } from "./logger.js";
import { AI_WORKFLOW_COMMENT_MARKER } from "./vcs-bot-identity.js";
import type { PrAutofixCapDecision } from "./pr-autofix-cap.js";
import type { PrTriggerType } from "./trigger-events.js";

export interface PrAutofixExhaustionNotice {
  provider: VcsProviderKind;
  repoPath: string;
  /** Target branch of the pull request. The VCS adapter is built per repository. */
  baseRef: string;
  prNumber: number;
  prUrl: string;
  /** Ticket owning this pull request's Slack thread, when the run had one. */
  ticketKey: string | null;
  /** Pull request identity, used as the Slack anchor when there is no ticket. */
  subjectKey: string;
  /** Which trigger's cap crossed, since the two caps read very differently to
   * a human: trigger_pr_checks_failed is an autofix loop that keeps failing
   * checks, trigger_pr_review is a loop of automatic replies to review
   * comments. Anything other than trigger_pr_review reads as the autofix
   * copy, since no other trigger type reaches this notice today. */
  triggerType: PrTriggerType;
  decision: PrAutofixCapDecision;
}

/**
 * Tell a human, exactly once, that this trigger's per-pull-request run cap has
 * been reached. Without this the refusal is invisible: no run row, no check,
 * no comment, so a customer sees nothing happen and the workflow simply stops.
 *
 * Idempotency rides on the cap's own tally rather than on a table of its own.
 * The tally keeps climbing after the refusal, so attempts === max + 1 is the
 * single call that crosses into exhaustion, and it is written to the database
 * before anything is sent. A crash between that write and the send therefore
 * loses the notice instead of repeating it, which is the safe direction here:
 * the notice is advisory, while a duplicate would be posted on a customer's
 * pull request. There is no retry driver on this path to make it at-least-once
 * anyway, since the delivery is completed terminally by the caller.
 *
 * A cap of zero (unreachable from an authored graph, which allows 1 to 10)
 * spends nothing and starts nothing, so its attempts of 0 never equals max + 1
 * and no notice goes out. There is nothing to report: no fix was ever tried.
 *
 * Nothing here may break dispatch. Both halves are attempted independently and
 * every failure is logged and swallowed, so the caller still refuses the run
 * whether or not the notice went out.
 */
export async function announcePrAutofixExhaustion(
  notice: PrAutofixExhaustionNotice,
): Promise<void> {
  const { decision } = notice;
  if (decision.allowed || decision.attempts !== decision.max + 1) return;

  const context = {
    provider: notice.provider,
    repoPath: notice.repoPath,
    prNumber: notice.prNumber,
    max: decision.max,
  };
  // A plain factory, safe outside workflow scope, and it hands back a messaging
  // adapter that no-ops when Slack is not configured.
  const adapters = createAdapters({
    provider: notice.provider,
    repoPath: notice.repoPath,
    baseBranch: notice.baseRef,
  });

  try {
    // The vcs property is read inside the try on purpose: the repository adapter
    // is built lazily, so a provider that is no longer configured throws here
    // rather than from the call, and that must not skip the Slack half. The
    // marker is unconditional for both variants: it is what stops the fix
    // summary (or this notice itself) from being read back as a new review.
    await adapters.vcs.postPRComment(
      notice.prNumber,
      `${exhaustionComment(notice.triggerType, decision.max)}\n\n${AI_WORKFLOW_COMMENT_MARKER}`,
    );
  } catch (error) {
    logger.warn(
      { ...context, error: errorMessage(error) },
      "pr_autofix_exhausted_comment_failed",
    );
  }

  try {
    // A note posts under the ticket's existing Slack thread without touching its
    // status line, and falls back to a top level message when there is no thread.
    // Without a ticket the pull request key anchors nothing, which is why the
    // text below names the pull request itself.
    await adapters.messaging.notifyForTicket(notice.ticketKey ?? notice.subjectKey, {
      kind: "note",
      text: exhaustionSlackText(notice),
    });
  } catch (error) {
    logger.warn(
      { ...context, error: errorMessage(error) },
      "pr_autofix_exhausted_slack_failed",
    );
  }
}

/**
 * Customer facing copy for the pull request. It is read by an engineer who has
 * never seen our documentation, so it names no internal concept and asks for
 * the two things a human can actually do. Branches on trigger type because the
 * two caps are not the same story: one is a fix loop reacting to failing
 * checks, the other is a reply loop reacting to review comments, and the
 * autofix copy is simply false on the review path (there are no "checks" to
 * still be failing, and no fix to push).
 *
 * The count is the cap itself: the dispatch that crosses it never started a
 * run, so exactly max were tried.
 */
function exhaustionComment(triggerType: PrTriggerType, max: number): string {
  if (triggerType === "trigger_pr_review") {
    return [
      "**Automatic replies to review comments have stopped for this pull request.**",
      "",
      `The limit of ${max} runs per pull request was reached, so nothing ` +
        "further happens on its own.",
      "",
      "Whoever configured this workflow can raise maxRunsPerPr on the review " +
        "trigger to allow more runs.",
      "",
      "This limit counts runs on this pull request only. Other pull requests " +
        "are not affected.",
    ].join("\n");
  }
  return [
    "**Automatic fixing has stopped for this pull request.**",
    "",
    `A fix was attempted automatically ${timesPhrase(max)}, which is the maximum ` +
      "allowed here. The checks are still failing, so nothing further will be " +
      "tried on its own.",
    "",
    "To move this forward you can:",
    "",
    "- push a fix to this branch yourself, and the checks will run again as usual, or",
    "- ask whoever set up this workflow to allow more automatic attempts.",
    "",
    "This limit counts attempts on this pull request only. Other pull requests " +
      "are not affected.",
  ].join("\n");
}

/** Slack copy. Its audience is internal, so it names the repository and links
 * out. Branches on trigger type for the same reason exhaustionComment does. */
function exhaustionSlackText(notice: PrAutofixExhaustionNotice): string {
  const label = `${notice.repoPath}#${notice.prNumber}`;
  if (notice.triggerType === "trigger_pr_review") {
    return (
      `Automatic replies to review comments stopped for <${notice.prUrl}|${label}>. ` +
      `The limit of ${notice.decision.max} runs per pull request was reached. ` +
      "Someone can raise maxRunsPerPr on the review trigger to allow more runs."
    );
  }
  return (
    `Automatic fixing stopped for <${notice.prUrl}|${label}>. ` +
    `A fix was attempted ${timesPhrase(notice.decision.max)} and the checks are ` +
    "still failing. Someone has to push a fix, or raise the maximum fix attempts " +
    "on the trigger."
  );
}

function timesPhrase(max: number): string {
  return max === 1 ? "1 time" : `${max} times`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
