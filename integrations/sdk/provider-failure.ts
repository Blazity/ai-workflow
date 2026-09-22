/**
 * What a provider's failure says about the values it was sent, decided in one
 * place for every integration.
 *
 * Two answers, and they mean opposite things to the person reading them:
 *
 * - REFUSED: the provider answered and said no to this configuration. A token
 *   it does not accept (401), a key without the permission (403), a project or
 *   an installation that does not exist (404), a request it calls invalid.
 *   Somebody has to change a value; waiting changes nothing.
 * - NO VERDICT: nothing was said about the values at all. The provider could
 *   not be reached, timed out, was rate limited (429, or GitHub's 403 that
 *   carries `retry-after` or `x-ratelimit-remaining: 0`), failed on its own side
 *   (5xx) or never produced a status. The same values may work in a minute.
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
      /** The HTTP status the provider refused with; null when an SDK error said it. */
      readonly status: number | null;
      readonly message: string;
    }
  | { readonly kind: "no_verdict"; readonly message: string };

/**
 * Read a failure: a `Response` that was not a success, or anything thrown.
 *
 * A thrown error is a refusal only when it carries the provider's answer:
 *
 * - a numeric `status` with the HTTP status the provider answered, which is
 *   what Octokit's `RequestError` carries (its `response.headers` are read for
 *   the rate limit signs), and what an integration's own client should put on
 *   the errors it throws for a non-2xx answer;
 * - this SDK's own words for a verdict: `FatalError` (retrying cannot help) and
 *   `IssueTrackerNotFoundError` (the provider says the thing does not exist).
 *
 * Any other error never reached the provider, or reached it and got nothing
 * back that is about these values (a timeout, a socket that died, a body that
 * does not parse), and is no verdict.
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
  // By name, the way the Workflow DevKit recognises it, so a copy of the error
  // (core redacts what it passes on) reads the same as the original.
  if (failure instanceof Error && failure.name === "FatalError") {
    return { kind: "refused", status: null, message };
  }
  if (failure instanceof IssueTrackerNotFoundError) {
    return { kind: "refused", status: 404, message };
  }
  const status = statusOf(failure);
  if (status === null) return { kind: "no_verdict", message };
  return fromStatus(status, headerReaderOf(failure), message);
}

/**
 * What a connection test returns for a failure: `{ ok: false, reason }` when
 * the provider refused the values, and a THROW when it gave no verdict, which
 * core files as the provider being unreachable and which leaves the connection
 * as it was. That is the whole of `ConnectionTestResult`'s contract in one
 * call, so a test reads:
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
 * provider's own message. A thrown error is rethrown as it was; a `Response`
 * with no verdict becomes an error naming its status.
 */
export function refusedOrThrow(
  failure: unknown,
  reason?: string,
): { readonly ok: false; readonly reason: string } {
  const read = readProviderFailure(failure);
  if (read.kind === "no_verdict") {
    if (failure instanceof Error) throw failure;
    throw new Error(`${read.message}, which says nothing about these values`);
  }
  return { ok: false, reason: reason ?? read.message };
}

/**
 * Only a 4xx refuses, and not every 4xx: 408 is a timeout, 429 a rate limit,
 * and a 403 that says when to try again is GitHub's spelling of a spent rate
 * limit. A 3xx that reached here and a 5xx are not answers about the values.
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
    status !== 429 &&
    !(status === 403 && isRateLimited(header));
  return refuses ? { kind: "refused", status, message } : { kind: "no_verdict", message };
}

function isRateLimited(header: (name: string) => string | null | undefined): boolean {
  return (
    Boolean(header("retry-after")) ||
    header("x-ratelimit-remaining") === "0" ||
    header("ratelimit-remaining") === "0"
  );
}

function statusOf(failure: unknown): number | null {
  if (!failure || typeof failure !== "object") return null;
  const status = (failure as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/** Octokit keeps the answer's headers on `response.headers`, lowercased. */
function headerReaderOf(failure: unknown): (name: string) => string | null | undefined {
  const headers = (failure as { response?: { headers?: unknown } }).response?.headers;
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
