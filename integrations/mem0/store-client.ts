/**
 * Every request the memory store (version 2 of the port, `store.ts`) sends to
 * Mem0, and the one place a Mem0 answer becomes a value or a `Mem0StoreFailure`
 * in the port's words: a code, a reason core can show without parsing a
 * sentence, and the HTTP status.
 *
 * Written against Mem0's OpenAPI document at mem0ai/mem0@ea9bbcabed98
 * (docs/openapi.json, 2026-09-23) and checked against the live platform on
 * 2026-09-25 (`live-probe.ts`; the README's provenance table lists both).
 *
 * Version 1's client (`client.ts`) stays as it is until the cut-over; this one
 * differs where the version 2 port asks more: a refusal carries `reason` and
 * `status`, a write says whether it may have landed, and every call the store
 * makes (search, update, delete with its linked memories, ping) is here.
 */
import {
  readProviderFailure,
  z,
  type IntegrationContext,
  type MemoryStoreFailureReason,
} from "@integrations/sdk";
import type { manifest } from "./manifest";

type Context = IntegrationContext<typeof manifest>;

const MEM0_API = "https://api.mem0.ai";

/**
 * One request's attempt. Core gives memory 60 seconds of waiting per step
 * (`MEMORY_CALL_BUDGET_MS`) and aborts `ctx.signal` past it; a member makes
 * several calls, so one slow answer must not spend it all.
 */
const MEM0_STORE_ATTEMPT_MS = 10_000;

/** The most one page of `POST /v3/memories/` holds (`page_size`, OpenAPI maximum). */
export const MEM0_STORE_PAGE_SIZE = 200;

/** The largest `top_k` a search takes (OpenAPI: 1 to 1000). */
export const MEM0_SEARCH_TOP_K_MAX = 1000;

/**
 * Whether a failed write may still have changed what Mem0 holds: `no` when
 * Mem0 answered that it did not (a 4xx) or nothing was sent (no connection was
 * ever made), `unknown` when the request may have left and no clear answer
 * came back (a timeout, a 5xx, a reset, a body cut short or one this client
 * cannot read). The store answers a whole apply as a refusal only when every
 * write failed with `no`.
 */
export type Mem0Landed = "no" | "unknown";

export class Mem0StoreFailure extends Error {
  override readonly name = "Mem0StoreFailure";
  constructor(
    readonly code: "unavailable" | "rejected",
    readonly detail: string,
    readonly landed: Mem0Landed,
    readonly reason?: MemoryStoreFailureReason,
    readonly status?: number,
  ) {
    super(detail);
  }
}

/**
 * One stored memory as `POST /v3/memories/` lists it. Only what the store
 * reads; Mem0 sends more (categories, structured attributes, synthesized).
 * `created_at` comes back to the second in a listing (seen live), which is
 * why the store orders by its own `addedAt` in metadata.
 */
const storedMemory = z.object({
  id: z.string().min(1),
  memory: z.string(),
  user_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  app_id: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().nullable().optional(),
  replaced_by: z.string().nullable().optional(),
});
export type Mem0Memory = z.infer<typeof storedMemory>;

/** The paginated envelope; Mem0's schema requires every field. */
const listingPage = z.object({
  count: z.number(),
  next: z.string().nullable(),
  results: z.array(storedMemory),
});

/** `POST /v3/memories/search/`: `results` only, each with its `score` in [0, 1]. */
const searchAnswer = z.object({
  results: z.array(z.object({ id: z.string().min(1), score: z.number().optional() })),
});

/**
 * `POST /v3/memories/add/`. With `infer: false` Mem0 answers synchronously,
 * `SUCCEEDED` with one result per message (an exact repeat of a text the
 * scope holds answers that memory's id, seen live); `PENDING` with an
 * `event_id` and no results is the queued answer the OpenAPI documents.
 */
const addAnswer = z.object({
  status: z.string().optional(),
  event_id: z.string().optional(),
  results: z
    .array(z.object({ id: z.string().min(1), data: z.object({ memory: z.string() }), event: z.string().optional() }))
    .optional(),
});
export type Mem0AddAnswer = z.infer<typeof addAnswer>;

/** `PUT /v1/memories/{id}/`: the memory as it is after the update. */
const updateAnswer = z.object({ id: z.string().min(1), memory: z.string() });

/** `DELETE /v1/memories/{id}/`: `cascade_count` only when `delete_linked=true` was sent. */
const deleteAnswer = z.object({ message: z.string().optional(), cascade_count: z.number().optional() });

/** `GET /v1/ping/`. Only `status` is always there; the rest is what the key resolves to. */
const pingAnswer = z.object({
  status: z.string(),
  org_id: z.string().optional(),
  project_id: z.string().optional(),
});
type Mem0Ping = z.infer<typeof pingAnswer>;

/**
 * Mem0's error bodies: `{ detail }` for authentication (seen live on a 401),
 * `{ error }` for a missing memory, `{ error, details: { message } }` for
 * validation, and `upgrade_required: true` on a 403 about the plan rather
 * than the key.
 */
const errorBody = z.object({
  detail: z.string().optional(),
  error: z.string().optional(),
  details: z.object({ message: z.string().optional() }).optional(),
  upgrade_required: z.boolean().optional(),
});

export type Mem0Filters = Readonly<Record<string, unknown>>;

interface Mem0Page {
  readonly memories: readonly Mem0Memory[];
  /** What Mem0 says the whole listing holds, for a check that no page shifted. */
  readonly count: number;
  readonly more: boolean;
}

interface Mem0ListOptions {
  /**
   * Also list the memories Merge folded into another, which Mem0 hides from a
   * default read and keeps with their text (its Dream page: `include_merged`).
   * The pinned OpenAPI does not list the field for this call; the live probe
   * sent it in the body and got a 200. Mem0 may ignore it (nothing had been
   * merged to show it working).
   */
  readonly includeMerged?: boolean;
}

export interface Mem0StoreClient {
  /** One page (1-indexed) of what `filters` selects. */
  listPage(filters: Mem0Filters, page: number, options?: Mem0ListOptions): Promise<Mem0Page>;
  /** Scores by memory id for `query` within `filters`, every match kept (`threshold` 0). */
  search(query: string, filters: Mem0Filters, topK: number): Promise<ReadonlyMap<string, number>>;
  /** Stores each text verbatim as one memory (Direct Import), all under the same fields and metadata. */
  addVerbatim(input: {
    readonly texts: readonly string[];
    readonly userId: string;
    readonly agentId: string;
    readonly appId: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<Mem0AddAnswer>;
  /** Replaces a memory's text and metadata in place; `missing` when Mem0 answered 404. */
  update(id: string, text: string, metadata: Readonly<Record<string, string>>): Promise<{ id: string } | "missing">;
  /**
   * Deletes one memory by id and, with `linked`, the older memories it
   * superseded; `missing` when Mem0 answered 404.
   */
  remove(id: string, options: { readonly linked: boolean }): Promise<{ cascaded: number } | "missing">;
  ping(): Promise<Mem0Ping>;
}

export function mem0StoreClient(ctx: Context): Mem0StoreClient {
  // Once Mem0 did not answer at all, or the step's memory time ran out, the
  // rest of the step fails at once without sending: core builds a fresh store
  // for every step, so a hanging Mem0 costs one attempt, not one per call.
  let gone: { detail: string; reason: MemoryStoreFailureReason } | null = null;

  async function send(
    path: string,
    init: { method: string; write: boolean; body?: unknown; query?: Record<string, string> },
  ): Promise<Response> {
    if (!gone && ctx.signal.aborted) gone = { detail: "The time this step gives memory ran out before Mem0 was asked.", reason: "timeout" };
    if (gone) throw new Mem0StoreFailure("unavailable", `${gone.detail} Mem0 was not asked again in this step.`, "no", gone.reason);
    const url = new URL(path, MEM0_API);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    try {
      return await ctx.http.fetch(url, {
        method: init.method,
        headers: {
          authorization: `Token ${ctx.connection.apiKey}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        timeoutMs: MEM0_STORE_ATTEMPT_MS,
        // Sent once: Mem0 has no idempotency key, so an add resent after a
        // lost answer may be stored twice, and core asks again later anyway.
        retries: 0,
      });
    } catch (error) {
      const failure = thrownFailure(error, init.write);
      if (failure.reason === "timeout" || failure.reason === "unreachable") gone = { detail: failure.detail, reason: failure.reason };
      throw failure;
    }
  }

  async function answered<T>(response: Response, schema: z.ZodType<T>, what: string, write: boolean): Promise<T> {
    if (!response.ok) throw await statusFailure(response, what, ctx.connection.apiKey);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Mem0StoreFailure(
        "unavailable",
        `Mem0 answered ${what} in a shape this integration does not read.`,
        write ? "unknown" : "no",
        undefined,
        response.status,
      );
    }
    return parsed.data;
  }

  return {
    async listPage(filters, page, options = {}) {
      const response = await send("/v3/memories/", {
        method: "POST",
        write: false,
        body: { filters, ...(options.includeMerged ? { include_merged: true } : {}) },
        query: { page: String(page), page_size: String(MEM0_STORE_PAGE_SIZE) },
      });
      const answer = await answered(response, listingPage, "a listing", false);
      return { memories: answer.results, count: answer.count, more: answer.next !== null };
    },

    async search(query, filters, topK) {
      const response = await send("/v3/memories/search/", {
        method: "POST",
        write: false,
        // threshold 0 keeps every match (Mem0's default, 0.1, drops some);
        // rerank stays off, it only reorders and adds latency.
        body: { query, filters, top_k: topK, threshold: 0, rerank: false },
      });
      const answer = await answered(response, searchAnswer, "a search", false);
      const scores = new Map<string, number>();
      for (const result of answer.results) {
        if (typeof result.score === "number" && Number.isFinite(result.score) && !scores.has(result.id)) scores.set(result.id, result.score);
      }
      return scores;
    },

    async addVerbatim(input) {
      const response = await send("/v3/memories/add/", {
        method: "POST",
        write: true,
        body: {
          messages: input.texts.map((content) => ({ role: "user", content })),
          user_id: input.userId,
          agent_id: input.agentId,
          app_id: input.appId,
          metadata: input.metadata,
          // Stored as written and synchronously: core's model already
          // distilled every item, and Mem0's extraction would reword or drop it.
          infer: false,
        },
      });
      const answer = await answered(response, addAnswer, "an add", true);
      if (answer.status === "FAILED") {
        throw new Mem0StoreFailure("unavailable", "Mem0 reported the add as FAILED, so nothing was stored.", "no", undefined, response.status);
      }
      return answer;
    },

    async update(id, text, metadata) {
      const response = await send(`/v1/memories/${encodeURIComponent(id)}/`, { method: "PUT", write: true, body: { text, metadata } });
      if (response.status === 404) return "missing";
      const answer = await answered(response, updateAnswer, "an update", true);
      return { id: answer.id };
    },

    async remove(id, options) {
      const response = await send(`/v1/memories/${encodeURIComponent(id)}/`, {
        method: "DELETE",
        write: true,
        ...(options.linked ? { query: { delete_linked: "true" } } : {}),
      });
      if (response.status === 404) return "missing";
      const answer = await answered(response, deleteAnswer, "a delete", true);
      return { cascaded: answer.cascade_count ?? 0 };
    },

    async ping() {
      const response = await send("/v1/ping/", { method: "GET", write: false });
      return answered(response, pingAnswer, "the key check", false);
    },
  };
}

/**
 * A status Mem0 answered, in the port's words. Mem0 documents 400, 401 and
 * 404 on its memory calls and nothing else; the rest follows its own Python
 * SDK (`mem0/exceptions.py`: 401 and 403 authentication, 413 quota, 429 rate
 * limit) and what HTTP says a status means.
 *
 * - 401, 403 (not a rate limit, not about the plan): the key; `key_rejected`.
 * - 403 with `upgrade_required`, 413: the plan or quota; `quota`.
 * - 429 (and a 403 that is a rate limit): `rate_limited`.
 * - 400, 409, 422: the request itself, which asking again will not change;
 *   `rejected`, with the status.
 * - anything else (5xx, 404 on a listing, 408, a status Mem0 never sent):
 *   `unavailable` with the status, and for a write, its fate unknown.
 */
async function statusFailure(response: Response, what: string, apiKey: string): Promise<Mem0StoreFailure> {
  const status = response.status;
  const said = errorBody.safeParse(await response.clone().json().catch(() => null));
  const body = said.success ? said.data : {};
  const words = body.details?.message ?? body.error ?? body.detail;
  // Mem0's words are quoted, so the key is taken out first: a provider that
  // echoes a request back would otherwise hand it to every log line.
  const quoted = words ? `: ${words.split(apiKey).join("[REDACTED]").slice(0, 200)}` : "";
  const rateLimited = status === 429 || (status === 403 && readProviderFailure(response).kind === "no_verdict");
  if (rateLimited) {
    const wait = response.headers.get("retry-after");
    return new Mem0StoreFailure("unavailable", `Mem0 rate limited ${what} (${status})${wait ? `; it asked to wait ${wait} s` : ""}.`, "no", "rate_limited", status);
  }
  if (status === 413 || (status === 403 && body.upgrade_required === true)) {
    return new Mem0StoreFailure("unavailable", `Mem0 refused ${what} under the project's plan (${status}); its quota may be spent${quoted}.`, "no", "quota", status);
  }
  if (status === 401 || status === 403) {
    return new Mem0StoreFailure("unavailable", `Mem0 refused the API key for ${what} (${status}); replace the key on the Mem0 connection.`, "no", "key_rejected", status);
  }
  if (status === 400 || status === 409 || status === 422) {
    return new Mem0StoreFailure("rejected", `Mem0 refused ${what} (${status})${quoted}.`, "no", undefined, status);
  }
  return new Mem0StoreFailure("unavailable", `Mem0 did not complete ${what} (${status}).`, "unknown", undefined, status);
}

/**
 * The system and undici codes that prove no connection to Mem0 was made, so
 * nothing was sent: the connection was refused, the name did not resolve, no
 * route led there, or connecting took too long. Found on the `cause` of
 * fetch's `TypeError` (an `AggregateError` when every address refused carries
 * the code as well), which `ctx.http` keeps.
 */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function neverConnected(error: unknown): boolean {
  let at: unknown = error;
  for (let depth = 0; depth < 4 && typeof at === "object" && at !== null; depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && NEVER_CONNECTED.has(code)) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A request that produced no status. `ctx.http` keeps the error's name and
 * cause and takes the key out of its message; the sentence here quotes
 * neither.
 */
function thrownFailure(error: unknown, write: boolean): Mem0StoreFailure {
  const read = readProviderFailure(error);
  if (read.kind === "refused" && read.malformed) {
    return new Mem0StoreFailure("unavailable", "The Mem0 API key cannot be sent in a request; paste it again as one line.", "no", "key_rejected");
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") {
    return new Mem0StoreFailure("unavailable", `Mem0 did not answer within ${MEM0_STORE_ATTEMPT_MS / 1000} s.`, write ? "unknown" : "no", "timeout");
  }
  if (name === "AbortError") {
    return new Mem0StoreFailure("unavailable", "The time this step gives memory ran out before Mem0 answered.", write ? "unknown" : "no", "timeout");
  }
  if (neverConnected(error)) return new Mem0StoreFailure("unavailable", "Mem0 could not be reached.", "no", "unreachable");
  // Anything else may have happened after the request left (a reset, a body
  // cut short, which `ctx.http` rethrows as a TypeError), so a write's fate is
  // not known, and `unreachable` would say there was no connection at all.
  return write
    ? new Mem0StoreFailure("unavailable", "The connection to Mem0 broke before its answer came back, so whether the write landed is not known.", "unknown")
    : new Mem0StoreFailure("unavailable", "The connection to Mem0 broke before its answer came back.", "no");
}
