import { defineIntegration, ISSUE_TRACKER_BOARD_FIELDS } from "@integrations/sdk";

/**
 * The id is exactly `jira` and it is permanent.
 *
 * It is not a label. `ticketSubjectKey` writes `ticket:jira:<KEY>` into every
 * run row that follows a ticket, and cancel, resume, the stall watchdog and
 * the reconciler all find a live run by comparing that string. Renaming the
 * integration would therefore not be a rename: it would be a migration over
 * run history, and until it ran every run in flight would be invisible to the
 * things that end it.
 */
export const manifest = defineIntegration({
  id: "jira",
  name: "Jira",
  description:
    "Watches a Jira project for tickets to work on, and comments, moves and reads them as a run progresses.",
  docsUrl: "https://developer.atlassian.com/cloud/jira/platform/webhooks/",
  connection: {
    fields: [
      {
        key: "baseUrl",
        label: "Site URL",
        description: "The Jira site this deployment works in, such as https://acme.atlassian.net.",
        env: "JIRA_BASE_URL",
        secret: false,
        format: "url",
      },
      {
        key: "apiToken",
        label: "API token",
        description:
          "A token for the account that comments and moves tickets. It needs to read and write issues in the project below, and to read its own account.",
        env: "JIRA_API_TOKEN",
        secret: true,
        // Not an identity field: the site URL above already names WHICH Jira
        // this is, and a run pins that. Marking the token as well would stop
        // every run in flight on an ordinary token rotation.
      },
      {
        key: ISSUE_TRACKER_BOARD_FIELDS.projectKey,
        label: "Project key",
        description: "The project whose tickets this deployment watches, such as ACME.",
        env: "JIRA_PROJECT_KEY",
        secret: false,
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        description:
          "The secret Jira signs its deliveries with. Without it this deployment cannot tell a real delivery from anyone else's and refuses every one.",
        env: "JIRA_WEBHOOK_SECRET",
        secret: true,
        optional: true,
      },
      {
        key: ISSUE_TRACKER_BOARD_FIELDS.backlogTransitionId,
        label: "Backlog transition id",
        description:
          "Set this when the backlog column can only be reached through a named transition rather than by its status name.",
        env: "JIRA_BACKLOG_TRANSITION_ID",
        secret: false,
        optional: true,
      },
      {
        key: ISSUE_TRACKER_BOARD_FIELDS.aiTransitionId,
        label: "AI column transition id",
        description:
          "Set this when the AI column can only be reached through a named transition rather than by its status name.",
        env: "JIRA_AI_TRANSITION_ID",
        secret: false,
        optional: true,
      },
      {
        key: ISSUE_TRACKER_BOARD_FIELDS.aiReviewTransitionId,
        label: "AI Review transition id",
        description:
          "Set this when the AI Review column can only be reached through a named transition rather than by its status name.",
        env: "JIRA_AI_REVIEW_TRANSITION_ID",
        secret: false,
        optional: true,
      },
    ],
  },
  capabilities: ["issue_tracker"],
  blocks: [],
  pages: [],
  health: [
    {
      id: "api",
      label: "Account access",
      description: "Jira accepts the token and reports the account it belongs to.",
      critical: true,
    },
    {
      id: "project",
      label: "Project access",
      description:
        "The configured project exists, is visible to this account, and has statuses to move tickets between.",
      // Critical, because a project key nobody can see is otherwise silent:
      // every delivery would be ignored as the wrong project and nothing would
      // say why. Until S12 the site, the token and the project key were
      // required environment variables, but required only to be present, so a
      // key with a typo booted fine then too; core's own Jira probe caught it
      // on the health page. This check is where that probe's project half went.
      critical: true,
    },
    {
      id: "webhook-registration",
      label: "Webhook registration",
      description:
        "A Jira webhook points at this deployment, is enabled, and sends issue updates.",
      // Not critical: a deployment can run entirely on the poller, which is
      // slower but complete. Core adds its own webhook delivery check beside
      // this one, and the two answer different questions: whether Jira is set
      // up to call, and whether a call has actually arrived.
      critical: false,
    },
  ],
});
