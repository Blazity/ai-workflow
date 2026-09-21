/**
 * The Slack Web API, through `ctx.http` and nothing else.
 *
 * Slack answers 200 with `{ ok: false, error: "..." }` for almost everything
 * that goes wrong, so a caller that only looked at the HTTP status would read
 * "not_in_channel" as a success. One place unwraps that, and everything above
 * it sees either a body or a named error.
 */
import type { IntegrationHttp } from "@integrations/sdk";

const SLACK_API = "https://slack.com/api";

/** A reply to one Slack call: its body, or the name Slack gave the refusal. */
export type SlackCall<T> =
  | { readonly ok: true; readonly body: T }
  /** Slack answered and refused. `error` is its own vocabulary, such as `not_in_channel`. */
  | { readonly ok: false; readonly error: string }
  /** Slack did not answer at all: a timeout, DNS, a socket that died. */
  | { readonly ok: false; readonly error: null; readonly cause: string };

export interface SlackApi {
  call<T extends Record<string, unknown>>(
    method: string,
    body: Record<string, string>,
  ): Promise<SlackCall<T>>;
}

/**
 * Form-encoded, which is what every method here takes, and one bearer token.
 *
 * Nothing retries: each of these is a write (post a message, edit one, delete
 * a scheduled one) except the history reads, and `ctx.http` already retries
 * those on its own. Reposting a message after an ambiguous 5xx is how a
 * channel gets the same line twice.
 */
export function slackApi(http: IntegrationHttp, token: string): SlackApi {
  return {
    async call(method, body) {
      let response: Response;
      try {
        response = await http.fetch(`${SLACK_API}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: new URLSearchParams(body).toString(),
        });
      } catch (error) {
        return { ok: false, error: null, cause: describe(error) };
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
      if (payload.ok === true) return { ok: true, body: payload as never };
      const error = typeof payload.error === "string" ? payload.error : "unknown_error";
      return { ok: false, error };
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError"
      ? "Slack did not answer in time"
      : error.message;
  }
  return String(error);
}
