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
import {
  env,
  getConfiguredVcsProviders,
  getVcsProviderConfig,
  type VcsProviderConfig,
  type VcsProviderKind,
} from "../../config/env.js";

/** Provider ids that carry a signed webhook, as system health observes them. */
export type WebhookProviderId = "github" | "gitlab" | "jira" | "slack" | "email";

/** The per-node trigger budget default a node's own params may override. */
export function triggerRateLimitDefaults(): {
  TRIGGER_RATE_LIMIT_MAX?: number;
  TRIGGER_RATE_LIMIT_WINDOW?: "minute" | "hour" | "day" | "month";
} {
  return {
    TRIGGER_RATE_LIMIT_MAX: env.TRIGGER_RATE_LIMIT_MAX,
    TRIGGER_RATE_LIMIT_WINDOW: env.TRIGGER_RATE_LIMIT_WINDOW,
  };
}

/** The issue-tracker columns and project the ticket triggers are scoped to. */
export function ticketBoardSettings(): {
  projectKey: string;
  aiColumn: string;
  aiReviewColumn: string;
  backlogColumn: string;
  /** Set only where the tracker needs a transition id to reach the backlog. */
  backlogTransitionId?: string;
} {
  return {
    projectKey: env.JIRA_PROJECT_KEY,
    aiColumn: env.COLUMN_AI,
    aiReviewColumn: env.COLUMN_AI_REVIEW,
    backlogColumn: env.COLUMN_BACKLOG,
    backlogTransitionId: env.JIRA_BACKLOG_TRANSITION_ID,
  };
}

/** The shared secret Jira signs its webhook deliveries with, when configured. */
export function jiraWebhookSecret(): string | undefined {
  return env.JIRA_WEBHOOK_SECRET;
}

/** GitHub webhook secret plus the single repository legacy deliveries name. */
export function githubWebhookSettings(): {
  secret?: string;
  owner?: string;
  repo?: string;
} {
  return {
    secret: env.GITHUB_WEBHOOK_SECRET,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
  };
}

/**
 * Every VCS provider this deployment has credentials for. Re-exposed rather than
 * re-derived: which fields make a provider "configured" is the environment
 * schema's own question, and a second answer to it would drift.
 */
export function configuredVcsProviders(): VcsProviderConfig[] {
  return getConfiguredVcsProviders();
}

/** GitLab webhook token plus the single project legacy deliveries name. */
export function gitlabWebhookSettings(): { secret?: string; projectId?: string } {
  return {
    secret: env.GITLAB_WEBHOOK_SECRET,
    projectId: env.GITLAB_PROJECT_ID,
  };
}

/** Slack request signing secret, absent when the integration is unconfigured. */
export function slackSigningSecret(): string | undefined {
  return env.SLACK_SIGNING_SECRET;
}

/**
 * The Slack user ids allowed to drive the slash command, already split and
 * trimmed. An empty list means the allowlist is not in force, which is what an
 * unset variable and a variable holding only separators both mean.
 */
export function slackAllowedUserIds(): string[] {
  if (!env.SLACK_ALLOWED_USER_IDS) return [];
  return env.SLACK_ALLOWED_USER_IDS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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
    case "github":
      return env.GITHUB_WEBHOOK_SECRET;
    case "gitlab":
      return env.GITLAB_WEBHOOK_SECRET;
    case "jira":
      return env.JIRA_WEBHOOK_SECRET;
    case "slack":
      return env.SLACK_SIGNING_SECRET;
    case "email":
      return env.RESEND_WEBHOOK_SECRET;
  }
}

/**
 * The one provider of this kind this deployment is configured for. Throws when
 * there is none, which is the existing contract: a caller that names a provider
 * has already decided it must exist.
 */
export function vcsProviderConfig(kind: VcsProviderKind): VcsProviderConfig {
  return getVcsProviderConfig(kind);
}

/** The issue tracker's base URL, for the ticket links run reads publish. */
export function issueTrackerBaseUrl(): string {
  return env.JIRA_BASE_URL;
}
