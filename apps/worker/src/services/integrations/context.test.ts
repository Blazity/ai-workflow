/**
 * What an integration's `ctx.http.fetch` does for the adapter calling it, and
 * for everyone who reads what it threw.
 *
 * Every request here goes to a real server on a loopback port through Node's
 * own `fetch`, because the behaviours under test are fetch's: which signal it
 * obeys, what it throws and what its message quotes. A mocked fetch would
 * answer whatever the mock was told, which is how a dropped signal survived
 * review in the first place.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { integrationManifest } from "@integrations/registry";
import { integrationRuntime } from "@integrations/registry/worker";
import {
  IssueTrackerNotFoundError,
  readProviderFailure,
  type IntegrationManifest,
} from "@integrations/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildIntegrationContext, redactedError } from "./context.js";

const manifest = integrationManifest("jira") as IntegrationManifest;

interface Server {
  readonly url: string;
  /** Requests that reached the server, by method. */
  readonly hits: string[];
  /** Settles when the first request has reached the server, so a test can
   *  end a request that is in flight rather than one a timer hopes is. */
  readonly received: Promise<void>;
  close(): Promise<void>;
}

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

/** A server that answers every request with `answer`, or never answers. */
async function serve(answer: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | "never"): Promise<Server> {
  const hits: string[] = [];
  let arrived = () => {};
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = http.createServer((req, res) => {
    hits.push(req.method ?? "");
    arrived();
    if (answer !== "never") answer(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const handle: Server = {
    url: `http://127.0.0.1:${port}/`,
    hits,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(handle);
  return handle;
}

function context(options: { lifetime?: AbortSignal; secrets?: string[] } = {}) {
  return buildIntegrationContext({
    manifest,
    values: {},
    secrets: options.secrets ?? [],
    lifetime: options.lifetime ?? new AbortController().signal,
  });
}

/** Everything reachable from a thrown error, flattened, for "is it anywhere". */
function everythingIn(error: unknown, depth = 0): string {
  if (depth > 8 || error === undefined || error === null) return "";
  if (!(error instanceof Error)) return String(error);
  return [
    error.name,
    error.message,
    String(error.stack ?? ""),
    JSON.stringify(Object.fromEntries(Object.entries(error))),
    everythingIn(error.cause, depth + 1),
  ].join("\n");
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to fail, and it succeeded");
}

describe("an adapter's own signal", () => {
  it("stops the request: an already-aborted signal never reaches the server", async () => {
    // The mistake: `{ ...init, signal }` overwrote the caller's signal with the
    // context's, so a deadline an adapter set for itself (Jira's attachment
    // setting, a 5 s status discovery) never operated at all.
    const server = await serve((_req, res) => res.end("ok"));

    const error = await rejection(
      context().http.fetch(server.url, { signal: AbortSignal.abort() }),
    );

    expect(error.name).toBe("AbortError");
    expect(server.hits).toEqual([]);
  });

  it("ends a request the server never answers, at the caller's deadline and not the attempt's", async () => {
    // Ended once the server holds the request, not on a timer: a timer raced
    // the request to the server, and under a loaded machine it sometimes won.
    const server = await serve("never");
    const caller = new AbortController();
    const pending = context().http.fetch(server.url, { signal: caller.signal });
    await server.received;
    caller.abort(new DOMException("caller gave up", "TimeoutError"));

    const error = await rejection(pending);

    // The caller's own reason, which is how its deadline is told from the
    // attempt's (30 s, "The operation was aborted due to timeout"); a policy
    // that ignored the caller would not settle before the test's own limit.
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toBe("caller gave up");
    // Not tried again after the caller left.
    expect(server.hits).toEqual(["GET"]);
  });
});

describe("the context's lifetime", () => {
  it("stops a request in flight when whoever holds the adapter ends it", async () => {
    // What memory's budget relies on: ending the lifetime has to stop the
    // request that is waiting now, not only the next one.
    const server = await serve("never");
    const lifetime = new AbortController();
    const pending = context({ lifetime: lifetime.signal }).http.fetch(server.url, {
      method: "POST",
    });
    await server.received;
    lifetime.abort(new DOMException("budget spent", "TimeoutError"));

    const error = await rejection(pending);

    expect(error.name).toBe("TimeoutError");
    expect(error.message).toBe("budget spent");
    expect(server.hits).toEqual(["POST"]);
  });
});

describe("retries", () => {
  it("never repeats a POST, even after a 503", async () => {
    // A write at these providers is a comment, a transition, a merge. Sending
    // it twice after an ambiguous 5xx posts it twice.
    const server = await serve((_req, res) => {
      res.statusCode = 503;
      res.end("busy");
    });

    const response = await context().http.fetch(server.url, { method: "POST", body: "{}" });

    expect(response.status).toBe(503);
    expect(server.hits).toEqual(["POST"]);
  });

  /** A server that answers 429 first, with `retryAfter` when given, then 200. */
  async function rateLimitedOnce(retryAfter: string | null) {
    let answered = 0;
    return serve((_req, res) => {
      answered += 1;
      if (answered === 1) {
        res.statusCode = 429;
        if (retryAfter !== null) res.setHeader("retry-after", retryAfter);
        res.end("slow down");
        return;
      }
      res.end("ok");
    });
  }

  it("sends a write again after a 429 when the caller says the provider allows it", async () => {
    // Slack's rate-limit guide: "wait for the indicated number of seconds
    // before retrying the same request". Its own client waited out every 429;
    // sending the write once and giving up lost the notification.
    const server = await rateLimitedOnce("0");

    const response = await context().http.fetch(server.url, {
      method: "POST",
      body: "text=hi",
      resendAfterRateLimit: true,
    });

    expect(response.status).toBe(200);
    expect(server.hits).toEqual(["POST", "POST"]);
  });

  it("sends a rate-limited write once when the caller did not say so", async () => {
    // A Jira create. Atlassian: "Only retry if the API is idempotent and the
    // response includes a Retry-After header." A create that did land and was
    // sent again is a second ticket.
    const server = await rateLimitedOnce("0");

    const response = await context().http.fetch(server.url, {
      method: "POST",
      body: JSON.stringify({ fields: { summary: "Login broken" } }),
    });

    expect(response.status).toBe(429);
    expect(server.hits).toEqual(["POST"]);
  });

  it("sends a rate-limited write once when the 429 did not say how long to wait", async () => {
    const server = await rateLimitedOnce(null);

    const response = await context().http.fetch(server.url, {
      method: "POST",
      body: "text=hi",
      resendAfterRateLimit: true,
    });

    expect(response.status).toBe(429);
    expect(server.hits).toEqual(["POST"]);
  });

  it("sends a write whose body is a stream once, whatever the caller asked", async () => {
    // The stream was read as it was sent; a second attempt would send nothing.
    const server = await rateLimitedOnce("0");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("text=hi"));
        controller.close();
      },
    });

    const response = await context().http.fetch(server.url, {
      method: "POST",
      body,
      duplex: "half",
      resendAfterRateLimit: true,
    } as RequestInit & { duplex: "half"; resendAfterRateLimit: true });

    expect(response.status).toBe(429);
    expect(server.hits).toEqual(["POST"]);
  });

  it("sends a rate-limited write once when the caller said once", async () => {
    const server = await rateLimitedOnce("0");

    const response = await context().http.fetch(server.url, {
      method: "POST",
      body: "{}",
      resendAfterRateLimit: true,
      retries: 0,
    });

    expect(response.status).toBe(429);
    expect(server.hits).toEqual(["POST"]);
  });

  it("repeats a GET after a 503, which is what makes the POST case meaningful", async () => {
    const server = await serve((_req, res) => {
      res.statusCode = 503;
      res.end("busy");
    });

    const response = await context().http.fetch(server.url);

    expect(response.status).toBe(503);
    expect(server.hits).toEqual(["GET", "GET", "GET"]);
  });
});

describe("what a failed request throws", () => {
  const KEY = "tok-4f9a2c1e8b\n7d3e";

  it("carries no secret, keeps its name and class, and hides the original", async () => {
    // A key pasted from a wrapped terminal keeps its line break, and Node
    // quotes the whole header value in the error it throws. Every caller logs
    // that message; the health screen shows it.
    const server = await serve((_req, res) => res.end("ok"));

    const error = await rejection(
      context({ secrets: [KEY] }).http.fetch(server.url, {
        headers: { Authorization: `Token ${KEY}` },
      }),
    );

    expect(error.message).toContain("[redacted]");
    expect(everythingIn(error)).not.toContain(KEY);
    expect(everythingIn(error)).not.toContain("tok-4f9a2c1e8b");
    expect(error).toBeInstanceOf(TypeError);
    expect(error.name).toBe("TypeError");
    expect(server.hits).toEqual([]);
  });

  it("still says why a request never reached the server", async () => {
    // What classifies a network failure as transient (the MCP tools, the
    // health screen) reads a TypeError's cause and its code. A redaction that
    // dropped them would turn every outage into an internal error.
    const server = await serve((_req, res) => res.end("ok"));
    const closedUrl = server.url;
    await server.close();

    const error = await rejection(context().http.fetch(closedUrl, { retries: 0 }));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as { code?: string }).code).toBe("ECONNREFUSED");
  });

  it("reports an attempt that ran out of time as a TimeoutError", async () => {
    const server = await serve("never");

    const error = await rejection(
      context().http.fetch(server.url, { timeoutMs: 50, retries: 0 }),
    );

    expect(error.name).toBe("TimeoutError");
    // At most the one attempt. Whether it reached the server inside 50 ms is
    // the machine's business, not the policy's, and asserting it raced.
    expect(server.hits.length).toBeLessThanOrEqual(1);
  });
});

describe("a connection value no request can carry", () => {
  const jira = integrationManifest("jira") as IntegrationManifest;
  function jiraContext(values: Record<string, string>) {
    return buildIntegrationContext({
      manifest: jira,
      values,
      secrets: [values.apiToken ?? ""].filter(Boolean),
      lifetime: new AbortController().signal,
    });
  }

  it("is refused before anything is sent, naming the field and not the value", async () => {
    // A token pasted from a terminal that wrapped it. Node refuses the header
    // too, with a TypeError that quotes the whole value and reads like a
    // network failure, so the card stayed Connected over a key that can never
    // work.
    const server = await serve((_req, res) => res.end("ok"));
    const token = "ATATT3x\nFF00-9c1e";
    const ctx = jiraContext({ baseUrl: server.url, apiToken: token, projectKey: "AIW" });

    const error = await rejection(
      ctx.http.fetch(server.url, { headers: { Authorization: `Bearer ${token}` } }),
    );

    expect(error.name).toBe("ConnectionValueError");
    expect((error as { field?: string }).field).toBe("apiToken");
    expect(error.message).toContain("API token");
    expect(error.message).toContain("line break");
    expect(everythingIn(error)).not.toContain("FF00-9c1e");
    expect(server.hits).toEqual([]);
  });

  it("names a site address typed without https://", async () => {
    const ctx = jiraContext({ baseUrl: "acme.atlassian.net", apiToken: "token", projectKey: "AIW" });

    const error = await rejection(ctx.http.fetch("acme.atlassian.net/_edge/tenant_info"));

    expect(error.name).toBe("ConnectionValueError");
    expect((error as { field?: string }).field).toBe("baseUrl");
    expect(error.message).toContain("has to start with https://");
  });
});

describe("a Slack notification that hit a rate limit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is delivered once Slack's wait has passed, as Slack's own client used to do", async () => {
    // The real Slack package, the real context, and Slack's documented answer
    // to a burst: HTTP 429 with Retry-After. Only `fetch` is replaced, at the
    // edge of the process.
    const answers = [
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      Response.json({ ok: true, ts: "1758300000.000900" }),
    ];
    const fetch = vi.fn(async () => answers.shift() ?? Response.json({ ok: false, error: "unexpected" }));
    vi.stubGlobal("fetch", fetch);

    const slack = integrationManifest("slack") as IntegrationManifest;
    const messaging = (
      integrationRuntime("slack")!.capabilities.messaging as (ctx: unknown) => {
        notifyForTicket(
          ticket: { key: string; url?: string },
          event: { kind: "note"; text: string },
          conversation: { handle: string | null; remember(): Promise<void>; forget(): Promise<void> },
        ): Promise<unknown>;
      }
    )(
      buildIntegrationContext({
        manifest: slack,
        values: { botToken: "xoxb-token", channelId: "C1" },
        secrets: ["xoxb-token"],
        lifetime: new AbortController().signal,
      }),
    );

    const delivery = await messaging.notifyForTicket(
      { key: "AWT-42" },
      { kind: "note", text: "deploying now" },
      { handle: "1758300000.000100", remember: async () => {}, forget: async () => {} },
    );

    expect(delivery).toEqual({ delivered: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("the copy core passes on of what a provider threw", () => {
  const SECRET = "atl-4f9a2c1e8b7d3e";

  it("is still the class core decides by, with the secret gone from everything", () => {
    // Core reads a ticket that no longer exists from `instanceof
    // IssueTrackerNotFoundError`. A copy that was a plain Error turned every
    // missing ticket into an outage.
    const original = new IssueTrackerNotFoundError("Ticket", `AWT-42 (token ${SECRET})`);

    const copy = redactedError(original, (text) => text.replaceAll(SECRET, "[redacted]"));

    expect(copy).toBeInstanceOf(IssueTrackerNotFoundError);
    expect(copy.name).toBe("IssueTrackerNotFoundError");
    expect((copy as { code?: string }).code).toBe("NOT_FOUND");
    expect(everythingIn(copy)).not.toContain(SECRET);
    expect(copy.message).toContain("[redacted]");
  });

  it("keeps the status and code a caller reads, and leaves the request behind", () => {
    const original = Object.assign(new Error(`GitLab refused ${SECRET}`), {
      status: 403,
      code: `E_${SECRET}`,
      fatal: true,
      request: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    const copy = redactedError(original, (text) => text.replaceAll(SECRET, "[redacted]")) as Error & {
      status?: number;
      code?: string;
      fatal?: boolean;
      request?: unknown;
    };

    expect(copy.status).toBe(403);
    expect(copy.code).toBe("E_[redacted]");
    expect(copy.fatal).toBe(true);
    expect(copy.request).toBeUndefined();
    expect(everythingIn(copy)).not.toContain(SECRET);
  });

  // GitHub answers a spent primary rate limit with 403 and
  // `x-ratelimit-remaining: 0` (REST "Rate limits" docs); Octokit's
  // RequestError carries the status and the answer's headers, lowercased.
  it("keeps a rate limit that only the answer's headers mark, and nothing else of the answer", () => {
    const original = Object.assign(new Error("API rate limit exceeded for installation ID 4242."), {
      name: "HttpError",
      status: 403,
      request: { headers: { authorization: `token ${SECRET}` } },
      response: {
        status: 403,
        url: "https://api.github.com/repos/acme/api/pulls/7",
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1758600000",
          "set-cookie": `session=${SECRET}`,
        },
        data: { message: "API rate limit exceeded" },
      },
    });

    const copy = redactedError(original, (text) => text.replaceAll(SECRET, "[redacted]"));

    expect(readProviderFailure(original).kind).toBe("no_verdict");
    expect(readProviderFailure(copy).kind).toBe("no_verdict");
    expect((copy as { response?: unknown }).response).toEqual({
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    });
    expect(everythingIn(copy)).not.toContain(SECRET);
  });

  // Gitbeaker puts no status on what it throws and keeps GitLab's answer as
  // `cause.response`; GitLab answers 401 for a token it does not accept.
  it("keeps a refusal whose client kept the answer on the error's cause", () => {
    const original = Object.assign(new Error("401 Unauthorized"), {
      cause: {
        description: "401 Unauthorized",
        request: new Request("https://gitlab.example.com/api/v4/projects/1", {
          headers: { "private-token": SECRET },
        }),
        response: new Response(null, { status: 401 }),
      },
    });

    const copy = redactedError(original, (text) => text.replaceAll(SECRET, "[redacted]"));

    expect(readProviderFailure(copy)).toMatchObject({ kind: "refused", status: 401 });
    expect(everythingIn(copy)).not.toContain(SECRET);
  });
});
