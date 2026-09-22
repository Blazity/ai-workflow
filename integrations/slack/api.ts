/**
 * The Slack Web API, through `ctx.http` and nothing else.
 *
 * Slack answers 200 with `{ ok: false, error: "..." }` for almost everything
 * that goes wrong, so a caller that only looked at the HTTP status would read
 * "not_in_channel" as a success. One place unwraps that, and everything above
 * it sees either a body, Slack's word for what it refused, or the fact that
 * Slack gave no verdict at all.
 *
 * Which failure is which is decided here and nowhere else: the HTTP status by
 * the SDK's rule (`readProviderFailure`: 429 and 5xx are no verdict), and
 * Slack's own error codes by the list below.
 */
import { readProviderFailure, type IntegrationHttp } from "@integrations/sdk";

const SLACK_API = "https://slack.com/api";

/**
 * Error codes Slack documents as its own trouble rather than a verdict on the
 * request: "a transient issue on our end", a catastrophic server error, the
 * service unavailable, POST data that arrived truncated, a rate limit, and a
 * workspace mid-migration to an Enterprise organisation ("intermittently
 * unavailable until the transition is complete"). Every other code is Slack
 * refusing what it was sent, which is what `not_in_channel` or `invalid_auth`
 * are.
 */
const NO_VERDICT_ERRORS = new Set([
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  "ratelimited",
  "team_added_to_org",
]);

/** A reply to one Slack call: its body, Slack's word for a refusal, or no verdict. */
export type SlackCall<T> =
  | { readonly ok: true; readonly body: T }
  /** Slack answered and refused. `error` is its own vocabulary, such as `not_in_channel`. */
  | { readonly ok: false; readonly error: string }
  /**
   * Slack gave no verdict: it could not be reached or did not answer in time,
   * it rate limited the call past what `ctx.http` waits out, it failed on its
   * side, or it answered something that is not a Web API reply.
   */
  | { readonly ok: false; readonly error: null; readonly cause: string };

export interface SlackApi {
  /**
   * A method Slack documents as `GET` (`conversations.history`,
   * `chat.getPermalink`), with its arguments in the query string. `ctx.http`
   * retries a GET after a timeout, a 429 or a 5xx.
   */
  get<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, string>,
  ): Promise<SlackCall<T>>;
  /**
   * A method Slack documents as `POST`, form encoded: every write, and
   * `auth.test`. `ctx.http` retries a 429, which Slack answers without doing
   * anything, and nothing else: reposting a message after an ambiguous 5xx is
   * how a channel gets the same line twice.
   */
  post<T extends Record<string, unknown>>(
    method: string,
    body: Record<string, string>,
  ): Promise<SlackCall<T>>;
}

export function slackApi(http: IntegrationHttp, token: string): SlackApi {
  const authorization = `Bearer ${token}`;
  return {
    get(method, params) {
      const query = new URLSearchParams(params).toString();
      return send(http, `${SLACK_API}/${method}${query ? `?${query}` : ""}`, {
        method: "GET",
        headers: { authorization },
      });
    },
    post(method, body) {
      return send(http, `${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: new URLSearchParams(body).toString(),
      });
    },
  };
}

async function send<T>(http: IntegrationHttp, url: string, init: RequestInit): Promise<SlackCall<T>> {
  let response: Response;
  try {
    response = await http.fetch(url, init);
  } catch (error) {
    return { ok: false, error: null, cause: describe(error) };
  }
  if (!response.ok && readProviderFailure(response).kind === "no_verdict") {
    await response.body?.cancel().catch(() => {});
    return {
      ok: false,
      error: null,
      cause:
        response.status === 429
          ? "Slack is rate limiting this app; try again shortly"
          : `Slack answered ${response.status}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      error: null,
      cause: `Slack answered ${response.status} with something that is not JSON`,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: null, cause: "Slack answered with something that is not an object" };
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.ok === true) return { ok: true, body: payload as T };
  const error = typeof payload.error === "string" ? payload.error : "unknown_error";
  if (NO_VERDICT_ERRORS.has(error)) {
    return { ok: false, error: null, cause: `Slack could not answer (${error})` };
  }
  return { ok: false, error };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError"
      ? "Slack did not answer in time"
      : error.message;
  }
  return String(error);
}
