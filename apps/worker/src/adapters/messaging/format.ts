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
    case "pr_ready":
      return `${head} PR ready (<${event.pr.url}|#${event.pr.number}>)`;
    case "failed":
      return event.phase ? `${head} failed (${event.phase})` : `${head} failed`;
    case "plan_approval_requested":
      return `${head} plan awaiting approval`;
    case "canceled":
      return `${head} canceled`;
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
      return appendUsage(
        `${head} needs clarification${tail}`,
        event.usageReport,
      );
    }

    case "pr_ready": {
      const prLink = `<${event.pr.url}|#${event.pr.number}>`;
      const withUsage = appendUsage(
        `${head} PR ready for review — ${prLink}`,
        event.usageReport,
      );
      return event.extraText ? `${withUsage}\n${event.extraText}` : withUsage;
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
  }
}

function jiraLink(ticketKey: string, jiraBaseUrl: string): string {
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
