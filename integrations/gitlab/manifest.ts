import {
  defineIntegration,
  VCS_BOT_LOGIN_FIELD,
  VCS_LEGACY_BOT_LOGIN_FIELD,
} from "@integrations/sdk";

export const manifest = defineIntegration({
  id: "gitlab",
  name: "GitLab",
  description:
    "Opens merge requests, reads review threads and pipelines, and receives project webhooks.",
  docsUrl: "https://docs.gitlab.com/user/project/integrations/webhooks/",
  connection: {
    fields: [
      {
        key: "token",
        label: "Access token",
        description: "A project or personal access token with API access to the repositories this deployment uses.",
        env: "GITLAB_TOKEN",
        secret: true,
        identity: true,
      },
      {
        key: "host",
        label: "GitLab URL",
        env: "GITLAB_HOST",
        secret: false,
        optional: true,
        default: "https://gitlab.com",
        format: "url",
      },
      {
        key: VCS_BOT_LOGIN_FIELD,
        label: "Bot username",
        description: "The username that posts automated comments, used to prevent review loops.",
        env: "GITLAB_BOT_LOGIN",
        secret: false,
        optional: true,
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        description: "The secret token sent in the X-Gitlab-Token header.",
        env: "GITLAB_WEBHOOK_SECRET",
        secret: true,
        optional: true,
        // Deployments run without it on their variables; stored values without it
        // would read Connected while every delivery is refused.
        requiredWhenStored: true,
      },
      {
        key: "legacyProjectId",
        label: "Legacy default project",
        description: "Keeps deployments that used one default project working while repositories move fully into the catalog.",
        env: "GITLAB_PROJECT_ID",
        secret: false,
        optional: true,
      },
      {
        ...VCS_LEGACY_BOT_LOGIN_FIELD,
        label: "Legacy bot username",
        description:
          "The bot's username from the old VCS_BOT_LOGIN variable, kept for deployments set up before each version control provider had its own. Read only while this is the one version control provider connected here; leave it empty otherwise.",
        secret: false,
        optional: true,
      },
    ],
  },
  capabilities: ["vcs"],
  // No host: a self-hosted GitLab is the normal case and the admin names it in
  // the GitLab URL field above, whose default core reads for gitlab.com. Groups
  // nest, so a project path is two segments or more. A merge request is `!12`:
  // `#12` names an issue here.
  repositories: {
    nestedPaths: true,
    changeRequest: { noun: "MR", referencePrefix: "!", linkSegment: "/-/merge_requests/" },
  },
  // A merge request note is the only review GitLab delivers: an approval or a
  // "request changes" arrives as no event a trigger can wait for.
  webhook: { reviewStates: ["commented"] },
  blocks: [],
  pages: [],
  health: [
    {
      id: "api",
      label: "API access",
      description: "GitLab accepts the token and returns the authenticated account.",
      critical: true,
    },
    {
      id: "projects",
      label: "Repository access",
      description: "At least one project is visible to the configured token.",
      critical: true,
    },
  ],
});
