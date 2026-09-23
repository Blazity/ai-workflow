/**
 * Mem0 for the tests, at the HTTP boundary: a context whose `http.fetch`
 * answers through a function, keeps every request, and a way to read the
 * bodies recorded from Mem0's documentation (`test-fixtures/`, each with its
 * `.source.txt`). Nothing here reaches the network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IntegrationContext } from "@integrations/sdk";
import type { manifest } from "./manifest";

/** Invented, distinctive, and checked for in every answer and log line. */
export const FAKE_KEY = "m0-FAKEKEYFORTESTS0123456789";

export type Context = IntegrationContext<typeof manifest>;

export interface Sent {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
  /** The `retries` the request asked core's HTTP client for; core resends nothing beyond it. */
  readonly retries: number | undefined;
}

export interface LogLine {
  readonly level: string;
  readonly fields: unknown;
  readonly event: string;
}

/** A context whose Mem0 answers each request with `respond`. */
export function mem0Answering(
  respond: (sent: Sent, index: number) => Response | Promise<Response>,
  options: { readonly apiKey?: string } = {},
) {
  const sent: Sent[] = [];
  const logs: LogLine[] = [];
  const line =
    (level: string) =>
    (fieldsOrEvent: unknown, event?: string): void => {
      logs.push(event === undefined ? { level, fields: {}, event: String(fieldsOrEvent) } : { level, fields: fieldsOrEvent, event });
    };
  const ctx: Context = {
    connection: { apiKey: options.apiKey ?? FAKE_KEY },
    http: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const text = await request.text();
        const entry: Sent = {
          method: request.method,
          url: new URL(request.url),
          headers: request.headers,
          body: text === "" ? undefined : JSON.parse(text),
          retries: init?.retries,
        };
        sent.push(entry);
        return respond(entry, sent.length - 1);
      },
    },
    log: { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") },
    signal: new AbortController().signal,
  };
  return { ctx, sent, logs };
}

/** The bytes of a recorded Mem0 body. */
export function fixtureText(name: string): string {
  return readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8");
}

/** A recorded Mem0 body as a response with the given status. */
export function recorded(name: string, status = 200): Response {
  return new Response(fixtureText(name), { status, headers: { "content-type": "application/json" } });
}

/** A recorded body, parsed, for a test that has to change one documented field. */
export function recordedJson<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A stored memory as the documented get-all record, with the fields a test sets. */
export interface FakeMemory {
  id: string;
  memory: string;
  user_id: string | null;
  agent_id: string | null;
  app_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * A Mem0 project in memory, answering the three calls this integration makes
 * the way Mem0's documentation says they answer:
 *
 * - `POST /v3/memories/`: the paginated envelope of `get-memories.json`, each
 *   record the documented record with its entity fields set (the documented
 *   example leaves out the optional ones). Filters are read as the filters page
 *   describes them: an `AND` of conditions, a bare value is equality, a
 *   `metadata` object matches each key by equality.
 * - `POST /v3/memories/add/` with `infer: false`: `direct-import-add.json`'s
 *   shape, one result per message, and an exact repeat in the same scope
 *   stored once (Direct Import: "Exact repeats in the same scope are
 *   deduplicated by an exact hash of the text").
 * - `DELETE /v1/memories/{id}/`: `delete-memory.json`, or
 *   `memory-not-found.json` with 404.
 *
 * `override` answers a request first when it returns a response, for a test
 * about one failure.
 */
export function fakeMem0(
  seed: readonly Partial<FakeMemory>[] = [],
  override?: (sent: Sent, index: number) => Response | undefined,
) {
  const documented = recordedJson<{ results: Record<string, unknown>[] }>("get-memories.json").results[0];
  let clock = Date.parse("2026-09-01T00:00:00Z");
  let serial = 0;
  const tick = () => new Date((clock += 1000)).toISOString();
  const nextId = () => `00000000-0000-4000-8000-${String((serial += 1)).padStart(12, "0")}`;
  // Each record starts as Mem0's documented one, so fields this fake does not
  // model still arrive the way Mem0 sends them.
  const memories: FakeMemory[] = seed.map((memory) => {
    const at = memory.created_at ?? tick();
    return {
      ...documented,
      id: nextId(),
      memory: "",
      user_id: null,
      agent_id: null,
      app_id: null,
      metadata: null,
      ...memory,
      created_at: at,
      updated_at: memory.updated_at ?? at,
    };
  });

  const matches = (memory: FakeMemory, condition: Record<string, unknown>): boolean =>
    Object.entries(condition).every(([field, wanted]) => {
      if (field === "AND") return (wanted as Record<string, unknown>[]).every((inner) => matches(memory, inner));
      if (field === "metadata") {
        return Object.entries(wanted as Record<string, unknown>).every(([k, v]) => memory.metadata?.[k] === v);
      }
      if (wanted === "*") return (memory as unknown as Record<string, unknown>)[field] !== null;
      return (memory as unknown as Record<string, unknown>)[field] === wanted;
    });

  const handle = (sent: Sent, index: number): Response => {
    const answer = override?.(sent, index);
    if (answer) return answer;
    const body = sent.body as Record<string, unknown> | undefined;
    if (sent.method === "POST" && sent.url.pathname === "/v3/memories/") {
      const filters = body?.filters as Record<string, unknown>;
      const page = Number(sent.url.searchParams.get("page") ?? "1");
      const size = Number(sent.url.searchParams.get("page_size") ?? "100");
      const all = memories.filter((memory) => matches(memory, filters));
      const results = all.slice((page - 1) * size, page * size);
      const next = page * size < all.length ? `https://api.mem0.ai/v3/memories/?page=${page + 1}&page_size=${size}` : null;
      return json({ count: all.length, next, previous: null, results });
    }
    if (sent.method === "POST" && sent.url.pathname === "/v3/memories/add/") {
      assert.equal(body?.infer, false, "this integration only ever adds with infer: false");
      const results = [];
      for (const message of (body?.messages ?? []) as { content: string }[]) {
        const scope = (memory: FakeMemory) =>
          memory.user_id === body?.user_id && memory.agent_id === body?.agent_id && memory.app_id === body?.app_id;
        if (memories.some((memory) => scope(memory) && memory.memory === message.content)) continue;
        const at = tick();
        const stored: FakeMemory = {
          ...documented,
          id: nextId(),
          memory: message.content,
          user_id: body?.user_id as string,
          agent_id: body?.agent_id as string,
          app_id: body?.app_id as string,
          metadata: body?.metadata as Record<string, unknown>,
          created_at: at,
          updated_at: at,
        };
        memories.push(stored);
        results.push({ id: stored.id, data: { memory: stored.memory }, event: "ADD" });
      }
      return json({ message: "Memories stored successfully", status: "SUCCEEDED", event_id: nextId(), results });
    }
    const one = /^\/v1\/memories\/([^/]+)\/$/u.exec(sent.url.pathname);
    if (sent.method === "DELETE" && one) {
      const at = memories.findIndex((memory) => memory.id === decodeURIComponent(one[1] ?? ""));
      if (at === -1) return recorded("memory-not-found.json", 404);
      memories.splice(at, 1);
      return recorded("delete-memory.json");
    }
    return new Response("no such route in this fake", { status: 418 });
  };

  return { memories, handle };
}

/**
 * Mem0 documents no 429 and no 5xx for these calls, so these answers are not
 * Mem0's: they carry only the status (and for the gateway, the HTML a proxy in
 * front of any API sends), and prove only how a status is read.
 */
export const undocumented = {
  rateLimited: (retryAfter?: string) =>
    new Response("", { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} }),
  unavailable: () => new Response("", { status: 503 }),
  gatewayPage: () =>
    new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    }),
};
