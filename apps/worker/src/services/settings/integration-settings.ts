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
import { env } from "../../infra/vcs-config.js";

/** Provider ids that carry a signed webhook, as system health observes them. */
export type WebhookProviderId = "jira" | "email";

/** The issue-tracker columns and project the ticket triggers are scoped to.
 *  The project key and the transition id are tracker wiring, not settings.
 *
 *  The snapshot is required. It used to be optional, and the three trigger
 *  entry points that left it out resolved their columns from the environment
 *  on the spot: a deployment whose operator had renamed a column on the
 *  Settings page kept dispatching against the old name from the poller while
 *  the dashboard showed the new one. */
export function ticketBoardSettings(settings: SettingsSnapshot): TicketBoardSettings {
  return {
    projectKey: env.JIRA_PROJECT_KEY,
    aiColumn: settings.COLUMN_AI,
    aiReviewColumn: settings.COLUMN_AI_REVIEW,
    backlogColumn: settings.COLUMN_BACKLOG,
    backlogTransitionId: env.JIRA_BACKLOG_TRANSITION_ID,
  };
}

interface TicketBoardSettings {
  projectKey: string;
  aiColumn: string;
  aiReviewColumn: string;
  backlogColumn: string;
  /** Set only where the tracker needs a transition id to reach the backlog. */
  backlogTransitionId?: string;
}

/** The shared secret Jira signs its webhook deliveries with, when configured. */
export function jiraWebhookSecret(): string | undefined {
  return env.JIRA_WEBHOOK_SECRET;
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

/** The configured secret for one provider, used to scope health observations. */
export function providerWebhookSecret(
  integrationId: WebhookProviderId,
): string | undefined {
  switch (integrationId) {
    case "jira":
      return env.JIRA_WEBHOOK_SECRET;
    case "email":
      return env.RESEND_WEBHOOK_SECRET;
  }
}

/** The issue tracker's base URL, for the ticket links run reads publish. */
export function issueTrackerBaseUrl(): string {
  return env.JIRA_BASE_URL;
}
