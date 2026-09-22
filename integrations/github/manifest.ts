import { defineIntegration } from "@integrations/sdk";

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
      },
      {
        key: "botLogin",
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
        key: "legacyBotLogin",
        label: "Legacy bot username",
        description: "Used only when this is the deployment's sole version-control provider.",
        env: "VCS_BOT_LOGIN",
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
