import type { IntegrationHttp, IntegrationRequestInit } from "@integrations/sdk";

/** Bitbucket Cloud's REST API 2.0. There is no self-hosted Cloud, so it is fixed. */
const BITBUCKET_API = "https://api.bitbucket.org/2.0";
/** Where a person opens a repository, and where git clones it from. */
export const BITBUCKET_WEB = "https://bitbucket.org";

/** `ctx.http`'s options, with headers as a plain record; the token is added. */
type BitbucketRequestInit = Omit<IntegrationRequestInit, "headers"> & {
  headers?: Record<string, string>;
};

/**
 * What Bitbucket answered, when it was not a success.
 *
 * Carries the answer where the SDK reads one (`providerAnswer`): the status on
 * the error and the headers on `response`. Bitbucket's own words, the
 * `error.message` of its error body, are the message and `cause.description`.
 */
export class BitbucketRequestError extends Error {
  readonly status: number;
  readonly response: Response;

  constructor(description: string, response: Response, options: { missingScope?: boolean } = {}) {
    // A token that lacks a scope refuses every pull request alike, so that is
    // the connection's fault rather than one pull request this token may not
    // read. The SDK reads it from `cause.description` (`isPullRequestRefusal`).
    super(description, {
      cause: { description: options.missingScope ? "insufficient_scope" : description, response },
    });
    this.name = "BitbucketRequestError";
    this.status = response.status;
    this.response = response;
  }
}

/** One page of a Bitbucket collection (`paginated_*` in the API reference). */
interface BitbucketPage<T> {
  values?: T[];
  next?: string;
  size?: number;
}

/**
 * The one way this integration talks to Bitbucket: every request goes through
 * the context's `fetch`, so it has core's attempt deadline and retry policy (a
 * read retried after a network error, a 429 or a 5xx; a write sent once), the
 * context's lifetime, and redaction of the connection's secrets.
 *
 * Every access token kind (workspace, project, repository) authenticates the
 * same way: `Authorization: Bearer <token>`.
 */
export interface BitbucketClient {
  /** `path` under `/2.0`, or an absolute URL Bitbucket returned (a `next`
   *  link). A non-2xx answer is returned, not thrown. */
  send(path: string, init?: BitbucketRequestInit): Promise<Response>;
  /** `send`, then the JSON body; a non-2xx answer is thrown as a
   *  `BitbucketRequestError`. A 204 is `undefined`. */
  json<T>(path: string, init?: BitbucketRequestInit): Promise<T>;
  /** Every value of a paginated collection, following `next` links, at most
   *  `maxPages` pages. */
  all<T>(path: string, options?: { maxPages?: number; init?: BitbucketRequestInit }): Promise<T[]>;
}

/** Pages a listing follows before it stops; 100 values a page. */
const DEFAULT_MAX_PAGES = 50;

export function bitbucketClient(connection: {
  readonly http: IntegrationHttp;
  readonly token: string;
}): BitbucketClient {
  const send = (path: string, init: BitbucketRequestInit = {}) =>
    connection.http.fetch(resolve(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        Accept: "application/json",
        ...init.headers,
      },
    });
  const json = async <T>(path: string, init?: BitbucketRequestInit): Promise<T> => {
    const response = await send(path, init);
    if (!response.ok) throw await requestError(response, init?.method ?? "GET", path);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  return {
    send,
    json,
    async all<T>(path: string, options: { maxPages?: number; init?: BitbucketRequestInit } = {}) {
      const values: T[] = [];
      let next: string | undefined = path;
      for (let page = 0; next && page < (options.maxPages ?? DEFAULT_MAX_PAGES); page += 1) {
        const body: BitbucketPage<T> = await json<BitbucketPage<T>>(next, options.init);
        values.push(...(body.values ?? []));
        next = body.next;
      }
      return values;
    },
  };
}

/**
 * A path under the API root, or a `next` link Bitbucket returned. A link to
 * any other origin is refused: the token is attached to every request, and a
 * page that pointed elsewhere would hand it over.
 */
function resolve(path: string): string {
  if (/^https?:\/\//iu.test(path)) {
    if (new URL(path).origin !== new URL(BITBUCKET_API).origin) {
      throw new Error(`Bitbucket returned a link outside ${BITBUCKET_API}; it was not followed.`);
    }
    return path;
  }
  return `${BITBUCKET_API}${path}`;
}

/** A non-2xx answer as the error every caller throws. */
export async function requestError(
  response: Response,
  method: string,
  path: string,
): Promise<BitbucketRequestError> {
  const { description, reason } = await describe(response, method, path);
  return new BitbucketRequestError(description, response, {
    missingScope: response.status === 403 && /\bscopes?\b/iu.test(reason),
  });
}

/** Bitbucket's reason: the error body's `error.message`, or the body itself. */
async function describe(
  response: Response,
  method: string,
  path: string,
): Promise<{ description: string; reason: string }> {
  const content = await response.text().catch(() => "");
  let reason = content;
  try {
    const parsed = JSON.parse(content) as { error?: { message?: unknown } } | null;
    if (typeof parsed?.error?.message === "string") reason = parsed.error.message;
  } catch {
    // Not JSON: the body as it came.
  }
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  return {
    description: `Bitbucket ${method} ${path.replace(BITBUCKET_API, "")} failed with ${status}${reason ? `: ${reason}` : ""}`,
    reason,
  };
}

/** `workspace/repo` as a path prefix, each segment encoded. */
export function repositoryPath(repoPath: string): string {
  return `/repositories/${repoPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** A branch name in a path: segments encoded, slashes kept, as the refs API
 *  addresses `feature/x`. */
export function branchPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** A value inside a BBQL string literal (`q=source.branch.name="..."`). */
export function bbqlString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}
