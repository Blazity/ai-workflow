import { createPrivateKey } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { FatalError, INTEGRATION_HTTP_DEFAULTS, type IntegrationHttp } from "@integrations/sdk";

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
 * Two forms are accepted: the `.pem` file GitHub downloads, pasted whole, and
 * the base64 of it, which is what the environment has carried since before
 * this integration existed. An admin holding the file has no reason to know we
 * ever wanted base64, and the two cannot be confused: a PEM says so on its
 * first line.
 *
 * Base64 is decoded exactly as main decoded it (`Buffer.from(value, "base64")`,
 * in `apps/worker/src/adapters/vcs/github-auth.ts` before S11), because values
 * set against that decoder are in production: it skips anything outside the
 * alphabet (the quotes a `.env` file adds, a wrapped line), needs no padding,
 * and the signing library then read a written backslash-n as a line break.
 * The same leniency is what once let a pasted PEM decode to a few hundred
 * bytes of rubbish and fail hours later (S11's trap), so it is only safe with
 * what follows: whatever is decoded has to hold a PEM block, and the block is
 * READ as a key before it is accepted. The shape says nothing about the bytes
 * (a key pasted with a line missing passes every pattern here, and used to
 * fail at the first request with a decoder error that read as GitHub being
 * unreachable), and GitHub signs App tokens with RS256, so an RSA key Node can
 * read is the only kind accepted.
 *
 * Silence is the one outcome that is never returned: either a key that will
 * sign, or a reason.
 */
export type PrivateKeyReading =
  | { readonly ok: true; readonly pem: string }
  | { readonly ok: false; readonly reason: string };

const PEM_BLOCK =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;

/** Only for choosing the sentence: whether the value at least looks like
 *  base64 (either alphabet: `Buffer.from(value, "base64")` below decodes the
 *  URL-safe one too), once the line breaks a wrapped value has and the quotes a
 *  `.env` file adds are gone. A space inside it means words, not base64. */
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/u;

const EXPECTED =
  "Paste the .pem file GitHub downloaded, starting with -----BEGIN RSA PRIVATE KEY-----, or the base64 encoding of that whole file.";

export function readPrivateKey(value: string | undefined): PrivateKeyReading {
  const raw = value ?? "";
  if (raw.trim().length === 0) {
    return { ok: false, reason: `No GitHub App private key is set. ${EXPECTED}` };
  }

  const pem = PEM_BLOCK.exec(withLineBreaks(raw))?.[0];
  if (pem) return readable(`${pem}\n`);

  const decodedPem = PEM_BLOCK.exec(withLineBreaks(Buffer.from(raw, "base64").toString("utf8")))?.[0];
  if (decodedPem) return readable(`${decodedPem}\n`);

  const packed = raw.trim().replace(/^"(.*)"$/su, "$1").replace(/[\r\n]+/gu, "");
  return {
    ok: false,
    reason: BASE64.test(packed)
      ? `The GitHub App private key is base64, but it does not decode to a PEM private key. ${EXPECTED}`
      : `The GitHub App private key is neither a PEM block nor base64. ${EXPECTED}`,
  };
}

/** A PEM that went through a shell or a deployment UI often has its line
 *  breaks written as the two characters backslash-n; it is the same key, and
 *  the signing library main used read it as one. */
function withLineBreaks(text: string): string {
  return text.replace(/\\r\\n|\\n/gu, "\n");
}

/** A PEM block that Node can read as an RSA private key, or why not. Node's own
 *  message is left out: it names a decoder routine, not what to do. */
function readable(pem: string): PrivateKeyReading {
  let type: string | undefined;
  try {
    type = createPrivateKey(pem).asymmetricKeyType;
  } catch {
    return {
      ok: false,
      reason: `The GitHub App private key has the shape of a PEM block but does not read as a key; a line may be missing or changed. ${EXPECTED}`,
    };
  }
  if (type !== "rsa") {
    return {
      ok: false,
      reason: `The GitHub App private key is not an RSA key (it reads as ${type ?? "an unknown type"}), and GitHub signs App tokens with RSA. ${EXPECTED}`,
    };
  }
  return { ok: true, pem };
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
 * The one GitHub client this integration has: Octokit with the App auth
 * strategy, sending every request through the context's `fetch`.
 *
 * Every call the integration makes goes through one of these, built from the
 * context: the adapter's REST and GraphQL calls, the connection test and the
 * health checks, a repository profile, a skill import, minting an
 * installation token and reading the App's bot identity. Octokit hands its
 * request to the App auth strategy, so the JWT exchange and the installation
 * token are fetched the same way. Each request then has core's attempt
 * deadline, core's retry policy (a read retried after a network error, a 429
 * or a 5xx; a write sent once), the context's lifetime, and throws with the
 * connection's secrets redacted.
 *
 * GraphQL is always a POST, which the context takes for a write, so a
 * GraphQL document that is not a mutation is marked as the read it is
 * (`graphqlReadRetries`); a mutation keeps the rule for writes.
 */
export function buildOctokit(
  credential: GitHubAppCredential,
  fetch: IntegrationHttp["fetch"],
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: credential.appId,
      privateKey: requirePrivateKey(credential.privateKey),
      installationId: credential.installationId,
    },
    request: {
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        fetch(input, { ...init, ...graphqlReadRetries(input, init) }),
    },
  });
}

/**
 * The read policy's retries for a GraphQL document that changes nothing.
 * Conservative on purpose: a document that mentions `mutation` anywhere is
 * left to the rule for writes, because sending a write twice is the mistake
 * that costs, and a read sent once only fails sooner.
 */
function graphqlReadRetries(
  input: string | URL | Request,
  init: RequestInit | undefined,
): { retries?: number } {
  if (init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") return {};
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  if (!new URL(url).pathname.endsWith("/graphql")) return {};
  let query: unknown;
  try {
    query = (JSON.parse(init.body) as { query?: unknown }).query;
  } catch {
    return {};
  }
  return typeof query === "string" && !/\bmutation\b/u.test(query)
    ? { retries: INTEGRATION_HTTP_DEFAULTS.retries }
    : {};
}

/**
 * A fresh installation access token, for where a raw token string has to go
 * into a git remote URL (the push site, a sandbox's source password). Minted
 * through the client's own auth strategy, and `refresh` so it is never a
 * cached one close to expiry: GitHub's lives about an hour from now. Do not
 * cache it outside the operation that needs it.
 */
export async function mintInstallationToken(octokit: Octokit): Promise<string> {
  const { token } = (await octokit.auth({ type: "installation", refresh: true })) as {
    token: string;
  };
  return token;
}

/**
 * The App's bot commit identity. Authoring commits with this `name`/`email`
 * pair makes GitHub render them with the App's avatar and the `[bot]` badge
 * rather than as the human who registered the App. The format is GitHub's own
 * noreply convention: `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`.
 *
 * Two calls: `GET /app` for the slug, on the App JWT, and
 * `GET /users/{slug}[bot]` for the numeric id, which the App auth strategy
 * sends on the installation token (only `/app` routes and a few others take
 * the JWT; see `requiresAppAuth` in `@octokit/auth-app`).
 */
export async function getBotIdentity(octokit: Octokit): Promise<{ name: string; email: string }> {
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
