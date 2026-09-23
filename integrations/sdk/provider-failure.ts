/**
 * What a provider's failure says about the values it was sent, decided in one
 * place for every integration.
 *
 * Two answers, and they mean opposite things to the person reading them:
 *
 * - REFUSED: the values are wrong, and waiting changes nothing. Either the
 *   provider answered and said no (401 a token it does not accept, 403 a key
 *   without the permission, 404 a project or an installation that does not
 *   exist, a request it calls invalid), or the values could not even form a
 *   request (`malformed`: a token with a line break, a URL that does not
 *   parse, a key that does not read as one), which no provider needed to see.
 * - NO VERDICT: nothing was said about the values at all. The provider could
 *   not be reached, timed out, was rate limited, failed on its own side (5xx)
 *   or never produced a status. The same values may work in a minute.
 *
 * Rate limits, from each provider's own documents: 429 everywhere (Slack,
 * Jira, GitLab, GitHub); GitHub also answers a spent limit with 403, which it
 * marks with `retry-after` or `x-ratelimit-remaining: 0`, or, for a secondary
 * limit, only with its message, recognised the way GitHub's own client does
 * (`@octokit/plugin-throttling`: `/\bsecondary rate\b/i`).
 *
 * A host that does not resolve (`getaddrinfo ENOTFOUND`) stays NO VERDICT,
 * deliberately: a VPN that is down or a split DNS says the same for a host that
 * exists. Core says which host could not be found and which field names it,
 * so the person can tell a typo from an outage themselves.
 *
 * Every integration used to decide this for itself, and four of them made the
 * same mistake: they caught every error and called it a refusal, so a thirty
 * second outage during a connection test turned a working card Failing. The
 * rule lives here so that nobody writes it again.
 *
 * `refusedOrThrow` is the connection test's half (see `ConnectionTestResult`);
 * `readProviderFailure` is for anything else that has to tell the two apart,
 * such as a health probe choosing its sentence.
 */
import { IssueTrackerNotFoundError } from "./issue-tracker";

export type ProviderFailure =
  | {
      readonly kind: "refused";
      /** The HTTP status the provider refused with; null when no status said it. */
      readonly status: number | null;
      /** The values could not form a request at all; the provider never saw one. */
      readonly malformed: boolean;
      readonly message: string;
    }
  | { readonly kind: "no_verdict"; readonly message: string };

/**
 * Read a failure: a `Response` that was not a success, or anything thrown.
 *
 * A thrown error is a refusal only when it carries a verdict:
 *
 * - the provider's answer, wherever its client kept it (see
 *   {@link providerAnswer}): a numeric `status` on the error, which is what
 *   Octokit's `RequestError` carries and what an integration's own client
 *   should put on the errors it throws for a non-2xx answer, or the `Response`
 *   a client kept as `cause.response` (Gitbeaker does, with no status on the
 *   error);
 * - this SDK's own words for a verdict: `FatalError` (retrying cannot help),
 *   `IssueTrackerNotFoundError` (the provider says the thing does not exist)
 *   and `ConnectionValueError` (no request could carry a value);
 * - a value the platform refused to turn into a request: a URL that does not
 *   parse (`ERR_INVALID_URL`, on the error or on its cause) or key data
 *   WebCrypto rejected (`DataError`).
 *
 * Any other error never reached the provider, or reached it and got nothing
 * back that is about these values (a timeout, a socket that died, a body that
 * does not parse), and is no verdict.
 *
 * The same on both sides of core's redaction boundary. Core passes on a copy
 * of what an integration throws, and the copy keeps the provider's status and
 * the headers in {@link PROVIDER_VERDICT_HEADERS}, so a GitHub 403 that is a
 * rate limit only by its headers is no verdict in core as it is here.
 */
export function readProviderFailure(failure: unknown): ProviderFailure {
  if (failure instanceof Response) {
    return fromStatus(
      failure.status,
      (name) => failure.headers.get(name),
      `The provider answered ${failure.status}${failure.statusText ? ` ${failure.statusText}` : ""}`,
    );
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  const refused = (malformed: boolean, status: number | null = null): ProviderFailure => ({
    kind: "refused",
    status,
    malformed,
    message,
  });
  // By name, the way the Workflow DevKit recognises `FatalError`, so core's
  // copy of the error (it redacts what it passes on) reads the same.
  if (failure instanceof Error && failure.name === "ConnectionValueError") return refused(true);
  if (isMalformedByPlatform(failure)) return refused(true);
  if (failure instanceof Error && failure.name === "FatalError") return refused(false);
  if (failure instanceof IssueTrackerNotFoundError) return refused(false, 404);
  const answer = providerAnswer(failure);
  if (answer === null) return { kind: "no_verdict", message };
  return fromStatus(answer.status, (name) => answer.headers[name] ?? null, message);
}

/**
 * The response headers a verdict reads: the signs of a rate limit
 * (`retry-after`, GitHub's `x-ratelimit-remaining`, the IETF draft's
 * `ratelimit-remaining`) and the challenge that names a missing scope
 * (`www-authenticate`, RFC 6750, 3.1). Core keeps exactly these, and the
 * status, on its copy of a failure, and nothing else of the answer.
 */
export const PROVIDER_VERDICT_HEADERS = [
  "retry-after",
  "x-ratelimit-remaining",
  "ratelimit-remaining",
  "www-authenticate",
] as const;

/** What a provider answered, as much of it as a verdict reads. */
export interface ProviderAnswer {
  readonly status: number;
  /** Only {@link PROVIDER_VERDICT_HEADERS}, by lowercase name, where present. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The provider's answer inside a failure, wherever its client kept it, as
 * plain data; `null` when the failure carries none.
 *
 * - a `Response`;
 * - an error with a numeric `status`, whose answer's headers are on
 *   `response.headers` (Octokit's `RequestError`, a `Headers` or a record of
 *   lowercase names, and core's copy of any failure);
 * - an error whose client kept the `Response` as `cause.response` and put no
 *   status on the error (Gitbeaker).
 */
export function providerAnswer(failure: unknown): ProviderAnswer | null {
  if (failure instanceof Response) return answerOf(failure.status, failure.headers);
  if (!failure || typeof failure !== "object") return null;
  const status = (failure as { status?: unknown }).status;
  if (typeof status === "number" && Number.isInteger(status)) {
    return answerOf(status, (failure as { response?: { headers?: unknown } }).response?.headers);
  }
  const kept = (failure as { cause?: { response?: unknown } }).cause?.response;
  return kept instanceof Response ? answerOf(kept.status, kept.headers) : null;
}

function answerOf(status: number, headers: unknown): ProviderAnswer {
  const read = headerReaderOf(headers);
  const picked: Record<string, string> = {};
  for (const name of PROVIDER_VERDICT_HEADERS) {
    const value = read(name);
    if (value !== null && value !== undefined) picked[name] = value;
  }
  return { status, headers: picked };
}

/**
 * What a connection test returns for a failure: `{ ok: false, reason }` when
 * the values were refused, and a THROW when there was no verdict, which core
 * files as the provider being unreachable and which leaves the connection as
 * it was. That is the whole of `ConnectionTestResult`'s contract in one call,
 * so a test reads:
 *
 * ```ts
 * if (!response.ok) return refusedOrThrow(response, "The provider refused the token.");
 * ```
 *
 * or, around a provider SDK that throws:
 *
 * ```ts
 * } catch (error) {
 *   return refusedOrThrow(error);
 * }
 * ```
 *
 * `reason` is what the admin reads for a refusal; without one it is the
 * provider's own message. A value no request could carry is answered with its
 * own sentence rather than `reason`, because that sentence names the field and
 * `reason` was written for a provider saying no; it is marked `malformed`, and
 * core files it as `value_malformed`. A thrown error with no verdict is
 * rethrown as it was; a `Response` with none becomes an error naming its
 * status.
 */
export function refusedOrThrow(
  failure: unknown,
  reason?: string,
): { readonly ok: false; readonly reason: string; readonly malformed?: true } {
  const read = readProviderFailure(failure);
  if (read.kind === "no_verdict") {
    if (failure instanceof Error) throw failure;
    throw new Error(`${read.message}, which says nothing about these values`);
  }
  if (read.malformed) return { ok: false, reason: read.message, malformed: true };
  return { ok: false, reason: reason ?? read.message };
}

/**
 * Only a 4xx refuses, and not every 4xx: 408 is a timeout, 425 asks for the
 * request again later (RFC 8470: a user agent "SHOULD retry automatically"),
 * 429 is a rate limit, and a 403 that is a rate limit is GitHub's (see the
 * header). A 3xx that reached here and a 5xx are not answers about the values.
 */
function fromStatus(
  status: number,
  header: (name: string) => string | null | undefined,
  message: string,
): ProviderFailure {
  const refuses =
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429 &&
    !(status === 403 && isRateLimited(header, message));
  return refuses
    ? { kind: "refused", status, malformed: false, message }
    : { kind: "no_verdict", message };
}

function isRateLimited(
  header: (name: string) => string | null | undefined,
  message: string,
): boolean {
  return (
    Boolean(header("retry-after")) ||
    header("x-ratelimit-remaining") === "0" ||
    header("ratelimit-remaining") === "0" ||
    /\bsecondary rate\b/iu.test(message)
  );
}

/**
 * Node's `new URL` and `fetch` put `ERR_INVALID_URL` on the error or on its
 * cause, and WebCrypto names key data it cannot import `DataError`. Neither
 * ever reached a provider.
 */
function isMalformedByPlatform(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false;
  if (failure.name === "DataError") return true;
  const codeOf = (value: unknown) =>
    value && typeof value === "object" ? (value as { code?: unknown }).code : undefined;
  return codeOf(failure) === "ERR_INVALID_URL" || codeOf(failure.cause) === "ERR_INVALID_URL";
}

/** Octokit keeps the answer's headers lowercased, as a record; a `Response`
 *  keeps a `Headers`. */
function headerReaderOf(headers: unknown): (name: string) => string | null | undefined {
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
