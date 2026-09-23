/**
 * Deployment settings for the integrations this worker talks to.
 *
 * Split out of `runtime-settings.ts` by subject: these are the credentials and
 * board names of the outside systems, the ones that differ per customer
 * deployment, while the sibling file holds what the worker is in itself. Both
 * follow the same rule, which is that accessors are functions and never
 * module-level snapshots, because the worker's tests replace the environment
 * module per case.
 */
import type { SettingsSnapshot } from "@shared/contracts";
import type { ResolvedIssueTracker } from "../../engine/support/issue-tracker-runtime.js";
import {
  NO_TICKET_LINKS,
  ticketLinksOf,
  type TicketLinks,
} from "../../engine/support/ticket-url.js";
import { env } from "../../infra/vcs-config.js";

/**
 * The board the ticket triggers are scoped to: where a ticket has to be for a
 * run to start, where a run puts it when it finishes, fails or parks, and how
 * the tracker is wired to reach those places.
 *
 * THE ONE SEAM where the two halves meet, and it has to stay the one seam. The
 * columns are operator behaviour and live in stored settings; the project and
 * the transition ids are provider wiring and live on the tracker's connection.
 * The snapshot argument used to be optional, and the three trigger entry
 * points that left it out resolved their columns separately: a deployment
 * whose operator had renamed a column kept dispatching against the old name
 * from the poller while the dashboard showed the new one. Reading either half
 * anywhere else brings that back.
 *
 * ASYNCHRONOUS since S12: the wiring half is an integration's connection now
 * rather than an environment variable, and reading a connection is a database
 * read. A deployment with no issue tracker connected has no board, and this
 * says so rather than handing back empty strings that would match nothing and
 * silently ignore every ticket.
 */
export async function ticketBoardSettings(
  settings: SettingsSnapshot,
): Promise<TicketBoardSettings> {
  const { resolveActiveIssueTracker } = await import(
    "../../engine/support/issue-tracker-runtime.js"
  );
  const tracker = await resolveActiveIssueTracker();
  if (!tracker.ok) throw new Error(tracker.reason);
  return ticketBoardOf(tracker, settings);
}

/**
 * The same board, from a tracker resolution the caller already holds. The
 * poller resolves the tracker once per tick for everything it does with it,
 * and a second read here could answer differently from the first.
 */
export async function ticketBoardOf(
  tracker: Extract<ResolvedIssueTracker, { ok: true }>,
  settings: SettingsSnapshot,
): Promise<TicketBoardSettings> {
  const { trackerIdentityOf } = await import("../../engine/support/issue-tracker-runtime.js");
  return {
    trackerName: tracker.name,
    trackerIdentity: trackerIdentityOf(tracker.id, tracker.wiring.connection),
    projectKey: tracker.wiring.projectKey,
    aiColumn: settings.COLUMN_AI,
    aiReviewColumn: settings.COLUMN_AI_REVIEW,
    backlogColumn: settings.COLUMN_BACKLOG,
    ...(tracker.wiring.backlogTransitionId
      ? { backlogTransitionId: tracker.wiring.backlogTransitionId }
      : {}),
    ...(tracker.wiring.aiTransitionId ? { aiTransitionId: tracker.wiring.aiTransitionId } : {}),
    ...(tracker.wiring.aiReviewTransitionId
      ? { aiReviewTransitionId: tracker.wiring.aiReviewTransitionId }
      : {}),
  };
}

export interface TicketBoardSettings {
  /**
   * What this deployment's issue tracker calls itself, for the sentences a
   * person reads about it: a cancellation reason on a ticket, an error in the
   * dashboard. Core writes the sentence and the provider supplies its own
   * name, so the words a person sees are unchanged while core spells no
   * provider.
   */
  trackerName: string;
  /** Which tracker instance this board belongs to, as an opaque string.
   *  Compared, never parsed: it is what stops a value cached against one
   *  connection being reused after an admin repointed it. */
  trackerIdentity: string;
  projectKey: string;
  aiColumn: string;
  aiReviewColumn: string;
  backlogColumn: string;
  /** Set only where the tracker needs a transition id to reach the column,
   *  rather than being able to move a ticket by its status name. */
  backlogTransitionId?: string;
  aiTransitionId?: string;
  aiReviewTransitionId?: string;
}

/** Svix signing secret for Resend delivery events. */
export function resendWebhookSecret(): string | undefined {
  return env.RESEND_WEBHOOK_SECRET;
}

/** Outbound email credentials, absent when email is not configured. */
export function outboundEmailSettings(): { apiKey?: string; from?: string } {
  return { apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_EMAIL };
}

/** The AES key the webhook trigger secrets are sealed with. */
export function webhookTriggerEncryptionKey(): string | undefined {
  return env.WEBHOOK_TRIGGER_ENCRYPTION_KEY;
}

/**
 * How the active issue tracker links a ticket, for the run reads that publish
 * ticket links: the port's `ticketUrl`, resolved once per read.
 *
 * No links when no tracker is usable, and that is the right answer here
 * rather than a refusal: every caller is building a link beside something else
 * it is already showing, and a run list that refused to render because a
 * tracker was disconnected would take away the page somebody needs in order to
 * see what happened. A link is dropped, the rest of the row stands, and a run
 * that recorded its own link keeps it (`ticketLinkFor`).
 */
export async function issueTrackerTicketLinks(): Promise<TicketLinks> {
  const { resolveActiveIssueTracker } = await import(
    "../../engine/support/issue-tracker-runtime.js"
  );
  const tracker = await resolveActiveIssueTracker();
  return tracker.ok ? ticketLinksOf(tracker.adapter) : NO_TICKET_LINKS;
}
