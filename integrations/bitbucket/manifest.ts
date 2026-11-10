/**
 * What core may know about the Bitbucket integration without running any of
 * its code. Plain data: the dashboard, the worker and the Workflow DevKit's
 * flow bundle all read this file, so it imports `@integrations/sdk` and
 * nothing else.
 */
import { defineIntegration, VCS_BOT_LOGIN_FIELD } from "@integrations/sdk";

export const manifest = defineIntegration({
  id: "bitbucket",
  name: "Bitbucket",
  description:
    "Opens pull requests in a Bitbucket Cloud workspace, reads and answers review comments, posts build statuses and Code Insights reports, and receives repository webhooks.",
  docsUrl: "https://support.atlassian.com/bitbucket-cloud/docs/access-tokens/",
  // Simple Icons "bitbucket" (CC0, simple-icons 16.32.0), in the brand's own colour.
  icon: {
    color: "#0052CC",
    glyph:
      "M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z",
  },
  connection: {
    fields: [
      {
        key: "workspace",
        label: "Workspace",
        description:
          "The workspace ID (the slug in bitbucket.org/<workspace>/...). The connection test checks that the token can list its repositories.",
        env: "BITBUCKET_WORKSPACE",
        secret: false,
      },
      {
        key: "token",
        label: "Access token",
        description:
          "A workspace, project or repository access token with the repository:write, pullrequest:write and webhook scopes. It is sent as a Bearer token and, for git, as the password of the x-token-auth user.",
        env: "BITBUCKET_ACCESS_TOKEN",
        secret: true,
      },
      {
        key: VCS_BOT_LOGIN_FIELD,
        label: "Bot account",
        description:
          "The access token's name as Bitbucket shows it on comments (or its account UUID), used to keep the workflow's own comments from starting another run.",
        env: "BITBUCKET_BOT_LOGIN",
        secret: false,
        optional: true,
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        description:
          "The secret set on the repository webhook. Bitbucket signs every delivery with it in the X-Hub-Signature header.",
        env: "BITBUCKET_WEBHOOK_SECRET",
        secret: true,
        optional: true,
        // Stored values without it would read Connected while every delivery
        // is refused, as GitHub's and GitLab's do.
        requiredWhenStored: true,
      },
    ],
  },
  capabilities: ["vcs"],
  // Bitbucket Cloud only: repositories live at bitbucket.org/<workspace>/<repo>,
  // and a path never nests deeper than that. Bitbucket calls a change request a
  // pull request and links it under `/pull-requests/<id>`.
  repositories: {
    host: "bitbucket.org",
    nestedPaths: false,
    changeRequest: { noun: "PR", referencePrefix: "#", linkSegment: "/pull-requests/" },
  },
  // A pull request comment, and a "Request changes" (which carries no text).
  webhook: { reviewStates: ["changes_requested", "commented"] },
  blocks: [],
  pages: [],
  health: [
    {
      id: "api",
      label: "API access",
      description: "Bitbucket accepts the access token and lists the workspace's repositories.",
      critical: true,
    },
    {
      id: "repositories",
      label: "Repository access",
      description: "At least one repository of the workspace is visible to the token.",
      critical: true,
    },
  ],
});
