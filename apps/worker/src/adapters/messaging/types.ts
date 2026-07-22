export type TicketEvent =
  | { kind: "started" }
  | {
      kind: "needs_clarification";
      /**
       * Deep link to the dashboard ticket view where a human answers the
       * questions. Preferred over commentUrl when present.
       */
      dashboardUrl?: string;
      /**
       * Deep link to a posted Jira comment (e.g. `?focusedCommentId=...`).
       * Retained for back-compat; the workflow no longer posts question
       * comments, so this is no longer sent. Falls back to the plain ticket
       * link when neither url is present.
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
  | {
      kind: "plan_approval_requested";
      /** Deep link to the dashboard view where a human approves the plan. */
      dashboardUrl?: string;
      /** Short excerpt of the proposed plan. Not rendered in the Slack copy. */
      planPreview?: string;
    }
  | { kind: "canceled"; reason: string }
  | {
      /**
       * Free-form message from a `send_slack_message` block in "always" mode.
       * Posted as a thread reply under the ticket status without touching the
       * top-level status line (see chatsdk `notifyForTicket`).
       */
      kind: "note";
      text: string;
    };

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
