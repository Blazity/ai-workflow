import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { FatalError, type IntegrationHttp } from "@integrations/sdk";

/**
 * The App credential, as this integration holds it.
 *
 * `privateKey` is whatever the source gave us, unread: the environment carries
 * base64 because a PEM's newlines do not survive every deployment's variable
 * editor, and an admin pasting into the dashboard has a `.pem` file. Both reach
 * here verbatim and are normalised in one place below, so the two sources
 * cannot disagree about what the value means.
 */
export interface GitHubAppCredential {
  appId: number;
  privateKey: string;
  installationId: number;
}

/**
 * The private key in the only form `@octokit/auth-app` can sign with, or a
 * sentence saying what was expected.
 *
 * This is the trap S11 exists to close. `Buffer.from(value, "base64")` does not
 * throw on input that is not base64: it drops every character outside the
 * alphabet and returns whatever bytes it can salvage. A `.pem` file pasted into
 * a field that wanted base64 therefore used to decode to a few hundred bytes of
 * rubbish, save cleanly, and fail hours later at the first API call with a
 * message about a bad key rather than about what was pasted.
 *
 * So both forms are accepted, and anything that is neither is refused with a
 * sentence naming them. Accepting both rather than refusing one is deliberate:
 * an admin holding the file GitHub downloaded has no reason to know we ever
 * wanted base64, and the two forms cannot be confused for one another, because
 * a PEM says so on its first line and `-` is not in the base64 alphabet.
 *
 * Silence is the one outcome that is never returned: either a key that will
 * sign, or a reason.
 */
export type PrivateKeyReading =
  | { readonly ok: true; readonly pem: string }
  | { readonly ok: false; readonly reason: string };

const PEM_BLOCK =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

const EXPECTED =
  "Paste the .pem file GitHub downloaded, starting with -----BEGIN RSA PRIVATE KEY-----, or the base64 encoding of that whole file.";

export function readPrivateKey(value: string | undefined): PrivateKeyReading {
  const raw = value ?? "";
  if (raw.trim().length === 0) {
    return { ok: false, reason: `No GitHub App private key is set. ${EXPECTED}` };
  }

  // A PEM pasted into an environment variable often arrives with its newlines
  // written as the two characters backslash-n, because that is what survives a
  // shell or a deployment UI. That is the same key, so it is read as one.
  const direct = raw.includes("-----BEGIN") ? raw.replace(/\\r\\n|\\n/gu, "\n") : raw;
  const pem = PEM_BLOCK.exec(direct)?.[0];
  if (pem) return { ok: true, pem: `${pem}\n` };

  const packed = raw.replace(/\s+/gu, "");
  if (packed.length % 4 !== 0 || !BASE64.test(packed)) {
    return {
      ok: false,
      reason: `The GitHub App private key is neither a PEM block nor base64. ${EXPECTED}`,
    };
  }
  const decoded = Buffer.from(packed, "base64").toString("utf8");
  const decodedPem = PEM_BLOCK.exec(decoded)?.[0];
  if (decodedPem) return { ok: true, pem: `${decodedPem}\n` };
  return {
    ok: false,
    reason: `The GitHub App private key is base64, but it does not decode to a PEM private key. ${EXPECTED}`,
  };
}

/**
 * The same reading, for the call sites that cannot carry on without a key.
 * `FatalError` because a malformed credential is not something a retry fixes.
 */
export function requirePrivateKey(value: string | undefined): string {
  const reading = readPrivateKey(value);
  if (!reading.ok) throw new FatalError(reading.reason);
  return reading.pem;
}

/**
 * Octokit pre-wired with the App auth strategy. Octokit mints and refreshes the
 * installation token internally per request, so every REST call from the
 * adapter goes through one of these.
 *
 * `fetch` is the context's (`ctx.http.fetch`), and a caller that has a context
 * passes it: every request then has core's timeout, is bound to the context's
 * lifetime (a connection test that runs out of time stops waiting on GitHub)
 * and throws with the connection's secrets redacted. Octokit hands the same
 * fetch to the App auth strategy, so minting the installation token goes
 * through it too.
 */
export function buildOctokit(
  credential: GitHubAppCredential,
  options: { readonly fetch?: IntegrationHttp["fetch"] } = {},
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: credential.appId,
      privateKey: requirePrivateKey(credential.privateKey),
      installationId: credential.installationId,
    },
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  });
}

/**
 * Mint an installation access token explicitly. Used where a raw token string
 * has to go into a git remote URL (the push site, a sandbox's source password).
 * Each call asks GitHub for a fresh token that lives about an hour; do not cache
 * it outside the operation that needs it.
 */
export async function mintInstallationToken(
  credential: GitHubAppCredential,
): Promise<string> {
  const appAuth = createAppAuth({
    appId: credential.appId,
    privateKey: requirePrivateKey(credential.privateKey),
    installationId: credential.installationId,
  });
  const result = await appAuth({ type: "installation" });
  return result.token;
}

/**
 * The App's bot commit identity. Authoring commits with this `name`/`email`
 * pair makes GitHub render them with the App's avatar and the `[bot]` badge
 * rather than as the human who registered the App. The format is GitHub's own
 * noreply convention: `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`.
 *
 * Two calls, both on the App JWT: `GET /app` for the slug and
 * `GET /users/{slug}[bot]` for the numeric id. No installation token is spent.
 */
export async function getBotIdentity(
  credential: GitHubAppCredential,
): Promise<{ name: string; email: string }> {
  const octokit = buildOctokit(credential);
  const { data: app } = await octokit.apps.getAuthenticated();
  const slug = app?.slug;
  if (!slug) {
    throw new Error("GitHub App response missing `slug`, so the bot identity cannot be derived.");
  }
  const username = `${slug}[bot]`;
  const { data: user } = await octokit.users.getByUsername({ username });
  return {
    name: username,
    email: `${user.id}+${username}@users.noreply.github.com`,
  };
}
