/**
 * Bitbucket for the tests, at the HTTP boundary: a context whose `http.fetch`
 * answers through routes, keeps every request it was asked, and nothing that
 * reaches the network. A route not listed answers 599, so a test that forgot
 * one fails loudly rather than reading an empty success.
 */
import { readFileSync } from "node:fs";
import type { IntegrationContext } from "@integrations/sdk";
import type { manifest } from "./manifest";

/** Invented, distinctive, and never a real credential. */
export const FAKE_TOKEN = "bb-FAKETOKENFORTESTS0123456789";

export type Context = IntegrationContext<typeof manifest>;

export interface Sent {
  readonly method: string;
  readonly url: URL;
  /** Path and query under `/2.0`, the way the routes name them. */
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
}

export type Route = (request: Sent) => Response | undefined | Promise<Response | undefined>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** A route answering one method and exact path (query included). */
export function on(method: string, path: string, answer: (request: Sent) => Response): Route {
  return (request) => (request.method === method && request.path === path ? answer(request) : undefined);
}

export function fakeBitbucket(routes: Route[], connection: Partial<Context["connection"]> = {}) {
  const sent: Sent[] = [];
  const ctx: Context = {
    connection: {
      workspace: "workspace_name",
      token: FAKE_TOKEN,
      botLogin: undefined,
      webhookSecret: undefined,
      ...connection,
    } as Context["connection"],
    http: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const request: Sent = {
          method: (init?.method ?? "GET").toUpperCase(),
          url,
          path: `${url.pathname.replace(/^\/2\.0/u, "")}${url.search}`,
          headers: new Headers(init?.headers as HeadersInit | undefined),
          body: typeof init?.body === "string" ? init.body : "",
        };
        sent.push(request);
        for (const route of routes) {
          const answer = await route(request);
          if (answer) return answer;
        }
        return json(599, { error: { message: `no route for ${request.method} ${request.path}` } });
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
  return { ctx, sent };
}

/** A recorded payload's bytes, exactly as committed. */
export function fixture(name: string): string {
  return readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8");
}

export const FULL_HEAD = "d3022fc0ca3d6e1f2a3b4c5d6e7f8091a2b3c4d5";
export const FULL_MERGE = "764413d85e29aaaabbbbccccddddeeeeffff0000";
