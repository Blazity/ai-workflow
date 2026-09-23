import { providerAnswer, readProviderFailure } from "./provider-failure";

/**
 * The one failure of a head read that core answers for good: this connection
 * can never read the pull request it was asked about.
 *
 * It exists because every other failure means the opposite. A token that
 * expired or was revoked, an App that was suspended or reinstalled, a token
 * without the scope or the permission to read pull requests: those refuse
 * EVERY pull request, they are the connection's fault, and fixing the
 * connection makes the same delivery work. So they are thrown as they came,
 * the delivery stays retryable, and a queued trigger is kept. Only a pull
 * request that does not exist for this connection, or that is forbidden to it
 * alone, is closed.
 *
 * Its own class rather than the Workflow DevKit's `FatalError`, which also
 * covers a refused credential and stops every retry wherever it is thrown.
 */
export class PullRequestUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PullRequestUnreadableError";
  }
}

/** By name, so a copy of the error made where it crosses into core (to redact
 *  it) still reads as what it is. */
export function isPullRequestUnreadableError(error: unknown): error is Error {
  return error instanceof Error && error.name === "PullRequestUnreadableError";
}

/**
 * Whether a provider's refusal of a request for ONE pull request says this
 * connection can never read it: a 404, or a 403 that refuses this resource
 * rather than the credential. A 401, a 429, a 5xx, a timeout, a 403 that is a
 * rate limit and a 403 that names a missing scope or permission are not.
 *
 * `failure` is the error as the provider's client threw it, or a `Response`.
 * `readProviderFailure` decides which answers are refusals and which 403 is a
 * rate limit, reading the answer wherever the client kept it. The one thing
 * this adds is which refusals can be about one pull request: a 404, and a 403
 * without the signs of a credential refused as a whole:
 *
 * - `WWW-Authenticate` naming `error="insufficient_scope"` (RFC 6750, 3.1);
 * - GitLab's `insufficient_scope`, the `error` of its 403 body, which its
 *   client keeps on `cause.description` (and, in 43.8.0, as the message);
 * - GitHub's `Resource not accessible by ...`, which GitHub's REST docs define
 *   as a token without the permission the endpoint needs.
 *
 * A provider whose 403 always means "this token may not" (GitHub's, on a pull
 * request) should not count a 403 at all; that is the caller's to narrow.
 * The caller also decides whether the refused request WAS about the pull
 * request: a GitHub App whose installation token cannot be minted surfaces
 * that refusal as the pull request read's error, and it is a credential fault.
 */
export function isPullRequestRefusal(failure: unknown): boolean {
  const read = readProviderFailure(failure);
  if (read.kind !== "refused" || read.malformed) return false;
  if (read.status === 404) return true;
  return read.status === 403 && !refusesTheCredential(failure);
}

function refusesTheCredential(failure: unknown): boolean {
  const challenge = providerAnswer(failure)?.headers["www-authenticate"] ?? "";
  if (/\berror="?insufficient_scope\b/iu.test(challenge)) return true;
  return textsOf(failure).some(
    (text) => text.trim() === "insufficient_scope" || /^Resource not accessible by\b/u.test(text),
  );
}

/** What the provider said, where clients keep it: the message, and GitLab's
 *  client's `cause.description`. */
function textsOf(failure: unknown): string[] {
  const message = failure instanceof Error ? failure.message : undefined;
  const description = (failure as { cause?: { description?: unknown } } | null)?.cause?.description;
  return [message, description].filter((text): text is string => typeof text === "string");
}
