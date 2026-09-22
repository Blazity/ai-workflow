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
 * `failure` is a `Response`, or a thrown error carrying the HTTP `status` and,
 * where the provider's client keeps them, the answer's headers on
 * `response.headers` (Octokit's `RequestError` does). Rate-limit signs:
 * `retry-after`, `x-ratelimit-remaining: 0` or `ratelimit-remaining: 0`, or a
 * message naming a secondary rate limit, which is how GitHub marks one.
 *
 * The caller still decides whether the refused request WAS about the pull
 * request: a GitHub App whose installation token cannot be minted surfaces that
 * refusal as the pull request read's error, and it is a credential fault.
 *
 * Once `provider-failure.ts` is in this package this body becomes one call,
 * `readProviderFailure(failure)` refusing with status 403 or 404, which reads
 * the same statuses and the same rate-limit signs.
 */
export function isPullRequestRefusal(failure: unknown): boolean {
  const status = statusOf(failure);
  if (status === 404) return true;
  if (status !== 403) return false;
  const header = headerReaderOf(failure);
  const said = (failure as { message?: unknown } | null)?.message;
  const message = typeof said === "string" ? said : "";
  const rateLimited =
    Boolean(header("retry-after")) ||
    header("x-ratelimit-remaining") === "0" ||
    header("ratelimit-remaining") === "0" ||
    /\bsecondary rate\b/iu.test(message);
  return !rateLimited;
}

function statusOf(failure: unknown): number | null {
  if (failure instanceof Response) return failure.status;
  const status =
    failure && typeof failure === "object" ? (failure as { status?: unknown }).status : undefined;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function headerReaderOf(failure: unknown): (name: string) => string | null {
  const headers =
    failure instanceof Response
      ? failure.headers
      : (failure as { response?: { headers?: unknown } } | null)?.response?.headers;
  if (headers instanceof Headers) return (name) => headers.get(name);
  if (headers && typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    return (name) => {
      const value = record[name];
      return value === undefined || value === null ? null : String(value);
    };
  }
  return () => null;
}
