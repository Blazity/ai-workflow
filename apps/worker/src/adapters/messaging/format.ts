import { pullRequestRef, pullRequestRepoLabels } from "@shared/contracts";
import type { RunPullRequest } from "@shared/contracts";
import type { TicketEvent } from "./types.js";

/**
 * Slack emoji prefixes per event kind. The palette differentiates three
 * states at a glance:
 *   - INFO (in progress / terminal info): :hourglass_flowing_sand:, :no_entry:
 *   - ACTION required from a human:        :question:, :warning:
 *   - DONE / ready for review:             :white_check_mark:
 */
const EVENT_EMOJI: Record<TicketEvent["kind"], string> = {
  started: ":hourglass_flowing_sand:",
  needs_clarification: ":question:",
  pr_ready: ":white_check_mark:",
  failed: ":warning:",
  plan_approval_requested: ":memo:",
  canceled: ":no_entry:",
  note: ":speech_balloon:",
};

/**
 * Short, status-bar style text for the parent (top-level) message that gets
 * edited in place on every event. Detailed event copy still goes in the
 * thread via {@link formatTicketEvent}.
 *
 * Examples:
 *   :hourglass_flowing_sand: <link|AWT-42> STATUS: in progress
 *   :white_check_mark: <link|AWT-42> STATUS: PR ready (<prUrl|#123>)
 *   :warning: <link|AWT-42> STATUS: failed (research)
 */
export function formatTicketStatus(
  event: TicketEvent,
  ticketKey: string,
  jiraBaseUrl: string,
): string {
  const link = jiraLink(ticketKey, jiraBaseUrl);
  const emoji = EVENT_EMOJI[event.kind];
  const head = `${emoji} ${link} STATUS:`;

  switch (event.kind) {
    case "started":
      return `${head} in progress`;
    case "needs_clarification":
      return `${head} needs clarification`;
    case "pr_ready": {
      // Every link inline: this line is what the channel shows without opening
      // the thread, so a multi-repo run must be clickable straight from it.
      const repoLabels =
        event.prs.length > 1 ? pullRequestRepoLabels(event.prs) : [];
      const links = event.prs
        .map((pr, i) => prSlackLink(pr, repoLabels[i]))
        .join(", ");
      // An empty list would render a dangling "PR ready ()". Senders guarantee
      // at least one, but this formatter is exported and the type allows [],
      // so degrade to the bare status instead of emitting broken copy.
      return links ? `${head} PR ready (${links})` : `${head} PR ready`;
    }
    case "failed":
      return event.phase ? `${head} failed (${event.phase})` : `${head} failed`;
    case "plan_approval_requested":
      return `${head} plan awaiting approval`;
    case "canceled":
      return `${head} canceled`;
    case "note":
      // Notes never edit the top-level status; chatsdk's note branch posts the
      // detail directly and never calls this. Present only for switch exhaustiveness.
      return "";
  }
}

/**
 * Format a TicketEvent as Slack-mrkdwn text with embedded links.
 *
 * Output is intended for `chat.channel(...).post(text)` or `thread.post(text)`.
 * Slack-native `<url|label>` syntax is used because remark/mdast escaping
 * via PostableMarkdown can mangle the angle brackets. We pass it as a plain
 * string; the chat package treats unmarked strings as PostableRaw on Slack.
 */
export function formatTicketEvent(
  event: TicketEvent,
  ticketKey: string,
  jiraBaseUrl: string,
): string {
  const link = jiraLink(ticketKey, jiraBaseUrl);
  const emoji = EVENT_EMOJI[event.kind];
  const head = `${emoji} Task ${link}`;

  switch (event.kind) {
    case "started":
      return `${head} started`;

    case "needs_clarification": {
      // Prefer the dashboard link (styled like plan_approval_requested's tail),
      // fall back to a Jira comment link, then plain.
      const tail = event.dashboardUrl
        ? ` (<${event.dashboardUrl}|answer in dashboard>)`
        : event.commentUrl
          ? ` (<${event.commentUrl}|view questions>)`
          : "";
      let body = `${head} needs clarification${tail}`;
      // Question and suggestion text derive from untrusted ticket content, so
      // defang Slack broadcast tokens in them (same rationale as extraText)
      // before they join our system-built copy.
      if (event.questions && event.questions.length > 0) {
        const lines = event.questions.map(
          (q, i) => `${i + 1}. ${neutralizeSlackBroadcasts(q)}`,
        );
        body += `\n${lines.join("\n")}`;
      }
      if (event.suggestedAnswers && event.suggestedAnswers.length > 0) {
        const suggested = event.suggestedAnswers
          .map((s) => neutralizeSlackBroadcasts(s))
          .join(" · ");
        body += `\nSuggested: ${suggested}`;
      }
      return appendUsage(body, event.usageReport);
    }

    case "pr_ready": {
      // One repository keeps the single-line copy; several get a bulleted list
      // qualified by provider and repo path, since two repos can carry the same
      // PR number and a bare "#12" would be ambiguous. An empty list drops the
      // link rather than announcing "(0):" with nothing under it — see the
      // matching guard in formatTicketStatus.
      const [first] = event.prs;
      const body =
        first === undefined
          ? `${head} PR ready for review`
          : event.prs.length === 1
            ? `${head} PR ready for review: ${prSlackLink(first)}`
            : [
                `${head} PR/MR ready for review (${event.prs.length}):`,
                ...event.prs.map(
                  (pr) => `• ${pr.provider}:${pr.repoPath}: ${prSlackLink(pr)}`,
                ),
              ].join("\n");
      const withUsage = appendUsage(body, event.usageReport);
      // extraText is user/ticket-derived (a send_slack_message block's message
      // after {{variable}} substitution), so defang Slack broadcast tokens in it
      // before it joins our system-built copy. Applied ONLY here, not to the
      // whole message, so our own <url|label> links are never touched.
      return event.extraText
        ? `${withUsage}\n${neutralizeSlackBroadcasts(event.extraText)}`
        : withUsage;
    }

    case "failed": {
      const body = formatFailedBody(event.phase, event.reason);
      return appendUsage(`${head} failed${body}`, event.usageReport);
    }

    case "plan_approval_requested": {
      const tail = event.dashboardUrl ? ` (<${event.dashboardUrl}|review plan>)` : "";
      return `${head} plan awaiting approval${tail}`;
    }

    case "canceled":
      return `${head} canceled: ${event.reason}`;

    case "note":
      // A note carries only the user's own message (already {{variable}}-substituted).
      // No system head/emoji so it reads as a plain message; defang broadcast tokens
      // so ticket-derived text can't ping the whole channel.
      return neutralizeSlackBroadcasts(event.text);
  }
}

/**
 * Defang Slack broadcast tokens in untrusted, ticket-derived text so they
 * render as literal text instead of pinging the channel.
 *
 * A broadcast token (`<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^...>`)
 * placed in a ticket title or description would otherwise notify everyone once
 * it is substituted into a Slack message body (Slack sends our strings as raw
 * mrkdwn, so it interprets these command links). We insert a zero-width space
 * after the `<` so Slack's parser no longer recognizes the `<!` opener; the text
 * stays human-readable.
 *
 * Legitimate `<@user>` mentions and `<url|label>` links do not start with `<!`,
 * so they are left untouched.
 */
export function neutralizeSlackBroadcasts(text: string): string {
  return text.replace(/<!(channel|here|everyone|subteam\^[^>]*)>/g, "<\u200b!$1>");
}

/**
 * Longest repository label the status line will carry. Slack has no ellipsis of
 * its own, so an unusually long repository name is cut here rather than pushing
 * the other links off the readable part of the line.
 */
const MAX_SLACK_REPO_LABEL = 24;

function truncateRepoLabel(label: string): string {
  if (label.length <= MAX_SLACK_REPO_LABEL) return label;
  // Drop a trailing separator so the cut reads "very…" rather than "very-…".
  return `${label.slice(0, MAX_SLACK_REPO_LABEL - 1).replace(/-+$/, "")}…`;
}

/**
 * Slack `<url|label>` for one PR/MR. The label is the provider-native reference
 * (`#12` on GitHub, `!12` on GitLab), prefixed with the repository name when the
 * run opened more than one so the links are told apart without a hover.
 */
function prSlackLink(pr: RunPullRequest, repoLabel?: string): string {
  const ref = pullRequestRef(pr);
  return `<${pr.url}|${repoLabel ? `${truncateRepoLabel(repoLabel)} ${ref}` : ref}>`;
}

/** Tracker keys look like "AWT-42". Synthesized run identifiers (webhook,
 *  schedule and scope:any PR runs) do not, and /browse/<that> is always a 404.
 *
 *  manual-dispatch/resolve.ts:607 accepts a wider key shape (it also allows "_"
 *  in the project part). The divergence is deliberate and this pattern is
 *  intentionally the stricter one: there, a rejected key blocks a dispatch, so
 *  it must be permissive; here, a key that fails only loses its hyperlink and
 *  renders as plain text. Underscore keys therefore degrade safely rather than
 *  risking a fabricated link, which is the direction we want to fail in. */
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

function jiraLink(ticketKey: string, jiraBaseUrl: string): string {
  if (!JIRA_KEY_PATTERN.test(ticketKey)) return ticketKey;
  const base = jiraBaseUrl.replace(/\/$/, "");
  return `<${base}/browse/${ticketKey}|${ticketKey}>`;
}

function formatFailedBody(
  phase: "research" | "impl" | "review" | "pre-pr-checks" | "push" | undefined,
  reason: string | undefined,
): string {
  if (phase && reason) return `: ${phase} — ${reason}`;
  if (reason) return `: ${reason}`;
  return "";
}

function appendUsage(base: string, usageReport: string | undefined): string {
  if (!usageReport) return base;
  return `${base}\n${usageReport}`;
}
