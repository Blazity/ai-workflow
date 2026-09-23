/**
 * The `messaging` capability port: what an integration implements so core can
 * tell people in a chat channel what a ticket's run is doing, and search what
 * they said. One provider is active per deployment.
 *
 * Core says what happened, as a typed event; the provider decides how it
 * looks. Nothing here names a provider, a channel or a markup dialect.
 *
 * Two things core keeps and never hands over: the conversation a ticket's
 * events belong to, which is a row in our database (`thread_parents`) and is
 * passed in as a handle the provider reads and writes through core; and what
 * delivery means, which is the answer every caller gets back rather than a
 * failure only the log sees.
 */
import type { RunPullRequest } from "@shared/contracts";

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
       * Deep link to the posted ticket comment (e.g. `?focusedCommentId=...`).
       * The workflow posts a best-effort questions comment on pause, so this is
       * sent when that post succeeds. Falls back to the plain ticket link when
       * neither url is present.
       */
      commentUrl?: string;
      /** The clarification questions, rendered numbered in the thread reply. */
      questions?: string[];
      /** Optional suggested answers, rendered on a single "Suggested" line. */
      suggestedAnswers?: string[];
      usageReport?: string;
    }
  | {
      /**
       * One entry per repository the run published to, so a run spanning a
       * GitHub repo and a GitLab repo (or two repos on one provider) links every
       * PR/MR instead of only the first. Senders only emit this event once a
       * publication produced at least one; the formatters still degrade to
       * link-less copy rather than trusting that.
       */
      kind: "pr_ready";
      prs: RunPullRequest[];
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
      /** Short excerpt of the proposed plan. Not rendered in the copy. */
      planPreview?: string;
    }
  | { kind: "canceled"; reason: string }
  | {
      /**
       * Free-form message from a `send_message` block in "always" mode. Posted
       * under the ticket's conversation without touching the status line: a
       * mid-run note must not overwrite "in progress" or "PR ready".
       */
      kind: "note";
      text: string;
    };

/**
 * Whether the message went out.
 *
 * The port still never throws, which is what lets a notification be
 * best-effort. It answers instead, so a caller that IS a block can report
 * `skipped` with the reason rather than `ok` for a message nobody received.
 * `reason` is a sentence for a person; it is written into the block's output
 * and its trace.
 */
export type MessagingDelivery =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

/**
 * The conversation a ticket's events belong to, as the provider sees it.
 *
 * `handle` is whatever the provider called the message it anchored the
 * conversation on, stored opaquely by core and handed straight back. Core
 * remembers it per ticket, so the thread survives a run, several runs and a
 * redeploy, and a second provider needs no table of its own.
 *
 * A handle a provider no longer recognises (a deleted message, or one another
 * provider wrote) is not an error: `forget()` it and anchor a new one. Core
 * never interprets the value.
 */
export interface MessagingConversation {
  readonly handle: string | null;
  /** Anchored a new conversation: remember this handle for the ticket. */
  remember(handle: string): Promise<void>;
  /** The handle no longer names anything; core drops it. */
  forget(): Promise<void>;
}

/**
 * The ticket an event is about, as the provider needs it: its key, and the
 * link a person can open. Core builds the link, because which tracker this
 * deployment talks to and whether this subject has a page there at all are
 * core's facts, not a chat provider's.
 */
export interface MessagingTicket {
  readonly key: string;
  readonly url: string | null;
}

/** What to look for. Scopes are the provider's own names for its channels. */
export interface MessageSearchQuery {
  readonly channels: readonly string[];
  readonly keywords: readonly string[];
  readonly lookbackDays: number;
  readonly maxResults: number;
}

export interface MessageSearchMatch {
  /** The provider's own name for where this was said. */
  readonly channel: string;
  /** The provider's id for the author, empty when a message has none. */
  readonly author: string;
  readonly text: string;
  /** A link a person can open. */
  readonly url: string;
  /** When it was said, ISO 8601, empty when the provider did not say. */
  readonly postedAt: string;
  /** Stable identity of the message within its channel, for a citation. */
  readonly id: string;
}

/**
 * Why nothing came back, coarse enough to act on and to report to a person: a
 * channel the bot was never invited to is a mistake somebody must fix, a
 * timeout is worth retrying, `unsupported` means this provider does not search
 * at all, and `not_connected` means no provider is active here. None of them
 * is "searched, found nothing", which is an empty match list.
 */
export type MessageRetrievalFailure =
  | "permission"
  | "timeout"
  | "unavailable"
  | "unsupported"
  | "not_connected";

/** A scope that was asked for and contributed nothing, and why. */
export interface MessageSearchSkip {
  readonly channel: string;
  readonly reason: MessageRetrievalFailure;
}

export type MessageSearchOutcome =
  | {
      readonly ok: true;
      readonly matches: readonly MessageSearchMatch[];
      readonly skipped: readonly MessageSearchSkip[];
    }
  | { readonly ok: false; readonly reason: MessageRetrievalFailure };

/**
 * What a messaging provider implements.
 *
 * Never throws: a failure is `{ delivered: false, reason }`, because a
 * notification must not be able to change a run's outcome and a caller that
 * needs to know gets told.
 */
export interface MessagingAdapter {
  /**
   * Send a ticket-scoped notification.
   *
   * Every event except a `note` carries the ticket's current status. With a
   * usable handle it updates the anchor message and replies under it; with no
   * handle, or one that no longer resolves (which is `forget`ten first), it
   * posts a new anchor carrying that status, `remember`s it and replies under
   * it. So the first event of any kind anchors the conversation, not only
   * `started`, and a vanished anchor is replaced by the next status event
   * rather than waiting for a run to start again. A `note` never anchors: it
   * replies under the handle when there is one and is posted on its own when
   * there is not.
   */
  notifyForTicket(
    ticket: MessagingTicket,
    event: TicketEvent,
    conversation: MessagingConversation,
  ): Promise<MessagingDelivery>;
  /**
   * Read what people said, for a research path. Optional: a provider that
   * cannot search leaves it out and core answers `unsupported`, which is a
   * normal state the research path reports and carries on from.
   */
  searchMessages?(query: MessageSearchQuery): Promise<MessageSearchOutcome>;
}

/**
 * What core hands anything that merely wants to say something: the same two
 * operations with the conversation already resolved, because remembering which
 * conversation a ticket owns is core's job and not the caller's.
 *
 * `searchMessages` is present whatever the active provider can do; a provider
 * with no search answers `unsupported` rather than being absent, so a caller
 * cannot take a "no provider" path by forgetting to check for a method.
 */
export interface MessagingSender {
  notifyForTicket(ticketKey: string, event: TicketEvent): Promise<MessagingDelivery>;
  searchMessages(query: MessageSearchQuery): Promise<MessageSearchOutcome>;
}
