import { createRequesterFn, type FormattedResponse } from "@gitbeaker/requester-utils";
import { Gitlab } from "@gitbeaker/rest";
import type { IntegrationHttp, IntegrationRequestInit } from "@integrations/sdk";

/**
 * The one way this integration talks to GitLab: every request goes through
 * the context's `fetch`, so it has core's attempt deadline, core's retry
 * policy (a read retried after a network error, a 429 or a 5xx, honouring
 * `Retry-After`; a write sent once), the context's lifetime, and throws with
 * the connection's secrets redacted.
 *
 * Two ways in, one transport. `api` is Gitbeaker's resources, for the calls it
 * models (merge requests, notes, discussions, branches, pipelines);
 * `send` is one REST call by path, for what Gitbeaker does not model or hides
 * (pagination headers, commit statuses, the discussion notes endpoint), and for
 * the connection test and health checks, which want GitLab's answer as it
 * came. Gitbeaker is handed a requester built on `send`, so it neither
 * reaches the global `fetch` nor retries on its own.
 */
export interface GitLabClient {
  /** The instance's root without a trailing slash, as the connection names it. */
  readonly host: string;
  readonly api: InstanceType<typeof Gitlab>;
  /**
   * `path` under `/api/v4`, with the token. A non-2xx answer is returned, not
   * thrown, exactly as `ctx.http.fetch` returns it.
   */
  send(path: string, init?: GitLabRequestInit): Promise<Response>;
}

/**
 * How long one GitLab request may take. GitLab ends a request it has worked on
 * for 60 s (its Rack timeout, `GITLAB_RAILS_RACK_TIMEOUT`, which an admin can
 * raise), so an attempt cut earlier than that gives up on an answer GitLab
 * would still have sent: a large merge request's diffs, a job log, or a note
 * that lands after 30 s and then reads as failed although it was posted. 15 s
 * on top is for the network and a slow proxy in front of a self-managed
 * instance. The context's 30 s default is sized for an API that answers in
 * seconds, which GitLab usually does and does not promise. A request that sets
 * its own `timeoutMs` keeps it.
 */
export const GITLAB_ATTEMPT_DEADLINE_MS = 75_000;

/** `ctx.http`'s options, with headers as a plain record; the token is added. */
export type GitLabRequestInit = Omit<IntegrationRequestInit, "headers"> & {
  headers?: Record<string, string>;
};

export function gitLabClient(connection: {
  readonly http: IntegrationHttp;
  readonly host: string;
  readonly token: string;
}): GitLabClient {
  const host = connection.host.replace(/\/+$/u, "");
  const send = (path: string, init: GitLabRequestInit = {}) =>
    connection.http.fetch(`${host}/api/v4${path}`, {
      timeoutMs: GITLAB_ATTEMPT_DEADLINE_MS,
      ...init,
      headers: { "PRIVATE-TOKEN": connection.token, ...init.headers },
    });
  return {
    host,
    send,
    api: new Gitlab({
      host,
      token: connection.token,
      // Gitbeaker builds each request (camelCase options to GitLab's names,
      // the query string, the token header) and this sends it.
      requesterFn: createRequesterFn(
        async (_resource, request) => request,
        (endpoint, options) => sendForGitbeaker(connection.http, endpoint, options ?? {}),
      ),
    }),
  };
}

/**
 * What GitLab answered, when it was not a success.
 *
 * Carries the answer where the SDK reads one (`providerAnswer`): the status on
 * the error and the headers on `response`. GitLab's own words, the `error` or
 * `message` of its JSON body, are the message and `cause.description`, which is
 * where Gitbeaker kept them and where `isPullRequestRefusal` looks for
 * `insufficient_scope`.
 */
export class GitLabRequestError extends Error {
  readonly status: number;
  readonly response: Response;

  constructor(description: string, response: Response) {
    super(description, { cause: { description, response } });
    this.name = "GitLabRequestError";
    this.status = response.status;
    this.response = response;
  }
}

/** Gitbeaker's request, sent through the context. Its shape (a prefix URL, a
 *  prepared query string, headers and a body) is `@gitbeaker/rest`'s own
 *  request handler's, which this replaces. */
async function sendForGitbeaker(
  http: IntegrationHttp,
  endpoint: string,
  options: Record<string, unknown>,
): Promise<FormattedResponse> {
  const { prefixUrl, searchParams, method, headers, body, signal, asStream } = options as {
    prefixUrl?: string;
    searchParams?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
    asStream?: boolean;
  };
  const base = prefixUrl ? (prefixUrl.endsWith("/") ? prefixUrl : `${prefixUrl}/`) : undefined;
  const url = new URL(endpoint, base);
  url.search = searchParams ?? "";
  const response = await http.fetch(url.toString(), {
    method,
    headers,
    body,
    timeoutMs: GITLAB_ATTEMPT_DEADLINE_MS,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new GitLabRequestError(await describe(response), response);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  if (asStream) {
    return { body: response.body as never, headers: responseHeaders, status: response.status };
  }
  return { body: await bodyOf(response), headers: responseHeaders, status: response.status };
}

/** GitLab's reason, as Gitbeaker read it: the JSON body's `error` or
 *  `message`, or the body itself. */
async function describe(response: Response): Promise<string> {
  const content = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return content;
  try {
    const parsed = JSON.parse(content) as { error?: unknown; message?: unknown } | null;
    const reason = parsed?.error ?? parsed?.message ?? "";
    return typeof reason === "string" ? reason : JSON.stringify(reason);
  } catch {
    return content;
  }
}

/** The body the way Gitbeaker's resources expect it. */
async function bodyOf(response: Response): Promise<FormattedResponse["body"]> {
  if (response.status === 204) return null;
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (type === "application/json") return ((await response.json()) as never) || {};
  if (type.startsWith("text/")) return (await response.text()) || "";
  return (await response.blob()) as never;
}
