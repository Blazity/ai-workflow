import { readProviderFailure } from "./provider-failure";

/**
 * The one failure of a head read that core answers for good: this connection
 * can never read the pull request it was asked about.
 *
 * It exists because every other failure means the opposite. A token that
 * expired or was revoked, an App that was suspended or reinstalled, a token
 * without the scope to read anything: those refuse EVERY pull request, they
 * are the connection's fault, and fixing the connection makes the same
 * delivery work. So they are thrown as they came, the delivery stays
 * retryable, and a queued trigger is kept. Only a pull request that does not
 * exist for this connection, or that is forbidden to it, is closed.
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
 * connection can never read it: exactly a 404, or a 403 that is not a rate
 * limit. A 401, a 429, a 5xx, a timeout and a 403 that is a rate limit are not.
 *
 * `failure` is what `readProviderFailure` reads: a `Response`, or a thrown
 * error carrying the HTTP `status` and, where the provider's client keeps
 * them, the answer's headers on `response.headers` (Octokit's `RequestError`
 * does). Which answers are refusals, and which 403 is a rate limit, is decided
 * there; the one thing this adds is that of every refusal only a 404 or a 403
 * can be about one pull request rather than about the values sent.
 *
 * The caller still decides whether the refused request WAS about the pull
 * request: a GitHub App whose installation token cannot be minted surfaces that
 * refusal as the pull request read's error, and it is a credential fault.
 */
export function isPullRequestRefusal(failure: unknown): boolean {
  const read = readProviderFailure(failure);
  return (
    read.kind === "refused" && !read.malformed && (read.status === 404 || read.status === 403)
  );
}
