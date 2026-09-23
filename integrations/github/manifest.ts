import {
  defineIntegration,
  VCS_BOT_LOGIN_FIELD,
  VCS_LEGACY_BOT_LOGIN_FIELD,
} from "@integrations/sdk";

/**
 * The GitHub App this deployment acts as.
 *
 * Every variable here is the one core read before S11, so a deployment already
 * configured by its environment keeps working with nothing to edit. The two
 * legacy fields exist for the same reason and are named as legacy so nobody
 * configures a new deployment with them; ADR-010 says when they die.
 *
 * There is no App install redirect yet: connecting through the dashboard means
 * supplying the three values from the App's settings page, exactly as the
 * environment supplies them. `docs/runbooks/GITHUB-APP-SETUP.md` walks it.
 */
export const manifest = defineIntegration({
  id: "github",
  name: "GitHub",
  description:
    "Opens pull requests, reads reviews and checks, imports skills and receives App webhooks.",
  docsUrl: "https://docs.github.com/apps/creating-github-apps",
  // Simple Icons "github" (CC0, simple-icons 16.32.0), in the brand's own colour.
  icon: {
    color: "#181717",
    glyph:
      "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  connection: {
    fields: [
      {
        key: "appId",
        label: "App ID",
        description: "The numeric App ID from the GitHub App's settings page.",
        env: "GITHUB_APP_ID",
        secret: false,
        format: "integer",
      },
      {
        key: "installationId",
        label: "Installation ID",
        description:
          "The numeric id of the App's installation on the account whose repositories this deployment works in. It is the last path segment of the installation's settings URL.",
        env: "GITHUB_INSTALLATION_ID",
        secret: false,
        format: "integer",
      },
      {
        key: "privateKey",
        label: "Private key",
        description:
          "The App's private key. Paste the .pem file as GitHub downloaded it, or its base64 form; both are accepted and a value that is neither is refused before the connection is activated.",
        env: "GITHUB_APP_PRIVATE_KEY",
        secret: true,
        format: "multiline",
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        description:
          "The secret configured on the App's webhook, used to verify every delivery to /webhooks/github.",
        env: "GITHUB_WEBHOOK_SECRET",
        secret: true,
        optional: true,
        // Deployments run without it on their variables; stored values without it
        // would read Connected while every delivery is refused.
        requiredWhenStored: true,
      },
      {
        key: VCS_BOT_LOGIN_FIELD,
        label: "Bot username",
        description:
          "The account that posts automated comments, used to prevent review loops. Usually <app-slug>[bot].",
        env: "GITHUB_BOT_LOGIN",
        secret: false,
        optional: true,
      },
      {
        key: "legacyOwner",
        label: "Legacy default owner",
        description:
          "Keeps deployments that named one repository working while repositories move fully into the catalog. Set together with the legacy repository.",
        env: "GITHUB_OWNER",
        secret: false,
        optional: true,
      },
      {
        key: "legacyRepo",
        label: "Legacy default repository",
        description: "The repository half of the legacy default pair.",
        env: "GITHUB_REPO",
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
  // github.com and nowhere else: this integration authenticates as a GitHub App
  // against api.github.com, so there is no host for an admin to change. A path
  // there is always exactly owner/name, which is what lets a pasted link be cut
  // after two segments whatever follows them.
  repositories: {
    host: "github.com",
    nestedPaths: false,
    changeRequest: { noun: "PR", referencePrefix: "#", linkSegment: "/pull/" },
  },
  // A submitted review carries its state; a review comment or a pull request
  // comment is a "commented" review of its own.
  webhook: { reviewStates: ["changes_requested", "commented"] },
  blocks: [],
  pages: [],
  health: [
    {
      id: "app",
      label: "App credentials",
      description: "GitHub accepts the App ID and private key and names the App back.",
      critical: true,
    },
    {
      id: "installation",
      label: "Installation",
      description:
        "The installation still exists on the account and still grants access to repositories.",
      critical: true,
    },
    {
      id: "webhook",
      label: "App webhook",
      description:
        "The App subscribes to the events this product needs, verifies TLS, and GitHub's own delivery log shows the last delivery succeeded.",
      critical: false,
    },
  ],
});
