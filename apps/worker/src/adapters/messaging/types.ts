export type TicketEvent =
  | { kind: "started" }
  | {
      kind: "needs_clarification";
      /**
       * Deep link to the posted Jira comment (e.g. `?focusedCommentId=...`).
       * When present, the Slack message links directly to the questions;
       * when absent, the formatter falls back to the plain ticket link.
       */
      commentUrl?: string;
      usageReport?: string;
    }
  | {
      kind: "pr_ready";
      pr: { url: string; number: number };
      usageReport: string;
      extraText?: string;
    }
  | {
      kind: "failed";
      phase?: "research" | "impl" | "review" | "pre-pr-checks" | "push";
      reason?: string;
      usageReport?: string;
    }
  | { kind: "canceled"; reason: string };

export interface MessagingAdapter {
  /**
   * Send a ticket-scoped notification to the configured channel.
   *
   * The first `started` event for a ticket posts top-level and records its
   * Slack message id as the lifetime parent. Subsequent events post as
   * thread replies under that parent. If the parent has been deleted, the
   * adapter clears the mapping and retries top-level (without re-anchoring
   * unless the new event is `started`).
   *
   * Never throws — failures are logged and swallowed so workflow runs are
   * never broken by a notification error.
   */
  notifyForTicket(ticketKey: string, event: TicketEvent): Promise<void>;
}
