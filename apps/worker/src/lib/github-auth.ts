import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface GitHubAppAuth {
  appId: number;
  /**
   * Base64-encoded PEM private key. Held encoded so this struct can be passed
   * through the workflow runtime, which lacks Node's `Buffer` and Web's `atob`
   * globals. Decoded to PEM only inside the functions below, which always run
   * in Node-runtime steps.
   */
  privateKeyBase64: string;
  installationId: number;
}

function decodePem(privateKeyBase64: string): string {
  return Buffer.from(privateKeyBase64, "base64").toString("utf8");
}

/**
 * Octokit instance pre-wired with the App auth strategy. Octokit handles
 * installation-token minting and refresh internally per request — use this
 * for all GitHub REST API calls from the adapter.
 */
export function buildOctokit(auth: GitHubAppAuth): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.appId,
      privateKey: decodePem(auth.privateKeyBase64),
      installationId: auth.installationId,
    },
  });
}

/**
 * Mint a fresh installation access token explicitly. Used at the git push
 * site (and Sandbox.create source.password) where we need a raw token string
 * to inject into git remote URLs. Each call hits GitHub's API to mint a new
 * ~1h-lived token; do not cache the result outside the operation that needs it.
 */
export async function mintInstallationToken(auth: GitHubAppAuth): Promise<string> {
  const appAuth = createAppAuth({
    appId: auth.appId,
    privateKey: decodePem(auth.privateKeyBase64),
    installationId: auth.installationId,
  });
  const result = await appAuth({ type: "installation" });
  return result.token;
}

/**
 * Resolve the GitHub App's bot commit identity. Authoring commits with this
 * `name`/`email` pair makes the GitHub UI render them with the App's avatar
 * and the `[bot]` badge, instead of the previous human owner who registered
 * the App. Format follows GitHub's noreply convention:
 *   `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`
 *
 * Two API calls (`GET /app` for the slug, `GET /users/{slug}[bot]` for the
 * numeric user id), both using the App JWT — no extra installation tokens.
 */
export async function getBotIdentity(
  auth: GitHubAppAuth,
): Promise<{ name: string; email: string }> {
  const octokit = buildOctokit(auth);
  const { data: app } = await octokit.apps.getAuthenticated();
  const slug = app?.slug;
  if (!slug) {
    throw new Error("GitHub App response missing `slug` — cannot derive bot identity");
  }
  const username = `${slug}[bot]`;
  const { data: user } = await octokit.users.getByUsername({ username });
  return {
    name: username,
    email: `${user.id}+${username}@users.noreply.github.com`,
  };
}
