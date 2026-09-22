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
import type { IntegrationManifest } from "@integrations/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { buildIntegrationContext } from "./context.js";

const manifest = integrationManifest("jira") as IntegrationManifest;

interface Server {
  readonly url: string;
  /** Requests that reached the server, by method. */
  readonly hits: string[];
  close(): Promise<void>;
}

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

/** A server that answers every request with `answer`, or never answers. */
async function serve(answer: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | "never"): Promise<Server> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.method ?? "");
    if (answer !== "never") answer(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const handle: Server = {
    url: `http://127.0.0.1:${port}/`,
    hits,
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
    const server = await serve("never");
    const caller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => caller.abort(new DOMException("caller gave up", "TimeoutError")), 100);

    const error = await rejection(
      context().http.fetch(server.url, { signal: caller.signal }),
    );

    expect(error.name).toBe("TimeoutError");
    // The attempt deadline is 30 s and a read tries three times; the caller's
    // 100 ms is what ended it, and it was not retried after the caller left.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
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
    setTimeout(() => lifetime.abort(new DOMException("budget spent", "TimeoutError")), 50);

    const error = await rejection(pending);

    expect(error.name).toBe("TimeoutError");
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
    expect(server.hits).toEqual(["GET"]);
  });
});
