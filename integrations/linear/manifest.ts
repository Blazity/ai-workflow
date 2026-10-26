import { defineIntegration, ISSUE_TRACKER_BOARD_FIELDS } from "@integrations/sdk";

export const manifest = defineIntegration({
  id: "linear",
  name: "Linear",
  description:
    "Watches a Linear team for issues to work on, and comments, moves and reads them as a run progresses.",
  docsUrl: "https://linear.app/developers/graphql",
  icon: {
    color: "#5E6AD2",
    glyph:
      "M3.102 3.929a.353.353 0 0 0 .015.486l16.463 16.463c.133.133.347.142.486.015C22.48 18.696 24 15.53 24 12.009 23.995 5.376 18.619 0 11.987 0 8.466 0 5.299 1.515 3.102 3.929M1.045 7.054a.353.353 0 0 0 .074.396l15.427 15.427c.104.104.262.135.396.074a12 12 0 0 0 1.04-.534c.2-.116.231-.389.067-.552L2.132 5.946c-.163-.163-.436-.133-.552.067a12 12 0 0 0-.535 1.04m-.936 4.418a.355.355 0 0 1-.104-.274q.048-.717.178-1.408c.052-.276.389-.372.588-.173l13.609 13.609c.199.199.103.536-.173.588a12 12 0 0 1-1.408.178.355.355 0 0 1-.274-.104zm.835 3.351c-.248-.248-.648-.034-.557.304 1.106 4.126 4.356 7.375 8.482 8.482.338.091.552-.309.304-.557z",
  },
  connection: {
    fields: [
      {
        key: "apiToken",
        label: "API key",
        description:
          "A Personal API Key for the account that comments and moves issues. It needs access to the team below.",
        env: "LINEAR_API_TOKEN",
        secret: true,
      },
      {
        key: ISSUE_TRACKER_BOARD_FIELDS.projectKey,
        label: "Team key",
        description: "The Linear team key whose issues this deployment watches, such as ENG.",
        env: "LINEAR_TEAM_KEY",
        secret: false,
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        description:
          "The signing secret Linear generates for its webhook. Without it this deployment cannot verify deliveries and refuses every one.",
        env: "LINEAR_WEBHOOK_SECRET",
        secret: true,
        optional: true,
      },
      {
        key: ISSUE_TRACKER_BOARD_FIELDS.backlogTransitionId,
        label: "Backlog state id",
        description:
          "Set this when the backlog column should be targeted by its workflow state UUID rather than by its status name.",
        env: "LINEAR_BACKLOG_STATE_ID",
        secret: false,
        optional: true,
      },
      {
        key: ISSUE_TRACKER_BOARD_FIELDS.aiTransitionId,
        label: "AI column state id",
        description:
          "Set this when the AI column should be targeted by its workflow state UUID rather than by its status name.",
        env: "LINEAR_AI_STATE_ID",
        secret: false,
        optional: true,
      },
      {
        key: ISSUE_TRACKER_BOARD_FIELDS.aiReviewTransitionId,
        label: "AI Review state id",
        description:
          "Set this when the AI Review column should be targeted by its workflow state UUID rather than by its status name.",
        env: "LINEAR_AI_REVIEW_STATE_ID",
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
      description: "Linear accepts the API key and reports the account it belongs to.",
      critical: true,
    },
    {
      id: "project",
      label: "Team access",
      description:
        "The configured team exists, is visible to this account, and has workflow states to move issues between.",
      critical: true,
    },
    {
      id: "webhook-registration",
      label: "Webhook registration",
      description:
        "A Linear webhook points at this deployment, is enabled, and sends issue updates.",
      critical: false,
    },
  ],
});
