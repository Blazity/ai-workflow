/**
 * Every request this integration sends to Mem0, and the one place a Mem0
 * answer becomes either a value or a `Mem0Failure`.
 *
 * Written against Mem0's hosted Platform API as its OpenAPI document described
 * it on 2026-09-23 (docs/openapi.json at mem0ai/mem0@fdfb763d6e5e), the pages
 * that render it under https://docs.mem0.ai/api-reference, and Direct Import
 * (https://docs.mem0.ai/platform/features/direct-import). The README's
 * provenance table lists each page.
 *
 * What the rest of the package can rely on:
 *
 * - A call either returns a parsed value or throws `Mem0Failure`, with a
 *   `code` in the memory port's words and a `detail` a person can read. Nothing
 *   else escapes: a fetch that throws, a status Mem0 did not document and a
 *   body that is not the shape Mem0 documents are all turned into one here.
 * - No detail carries the API key, a response body that is not Mem0's JSON
 *   (an HTML error page never reaches a log), or more than 200 characters of
 *   what Mem0 said.
 * - Once Mem0 did not answer at all (a timeout, a connection that failed), every
 *   later call on the same client fails at once without sending anything. Core
 *   builds a fresh adapter for every step, so this spends at most one attempt
 *   timeout per step on a Mem0 that hangs instead of one per call.
 */
import {
  readProviderFailure,
  z,
  type IntegrationContext,
  type MemoryFailure,
} from "@integrations/sdk";
import type { manifest } from "./manifest";

type Context = IntegrationContext<typeof manifest>;

/**
 * The hosted Platform API. A self-hosted Mem0 server speaks a different API
 * (its own paths and an `X-API-Key` header), so this is not a connection field:
 * pointing this client at one would fail on every call.
 */
const MEM0_API = "https://api.mem0.ai";

/**
 * One request's attempt. Core gives memory 60 seconds of waiting per step; a
 * step makes several calls, so one slow answer must not spend it all.
 */
export const MEM0_ATTEMPT_MS = 10_000;

/** The most Mem0 hands back in one page of a listing (`page_size`, OpenAPI maximum). */
export const MEM0_PAGE_SIZE = 200;

export class Mem0Failure extends Error {
  override readonly name = "Mem0Failure";
  constructor(
    readonly code: MemoryFailure,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * One stored memory as `POST /v3/memories/` answers it. Only what this
 * integration reads; Mem0 sends more (categories, structured attributes).
 * `id` is not checked as a UUID: Mem0's own documented example carries one that
 * is not.
 */
const storedMemory = z.object({
  id: z.string().min(1),
  memory: z.string(),
  user_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().nullable().optional(),
});
export type StoredMemory = z.infer<typeof storedMemory>;

/** The paginated envelope; every field is required by Mem0's schema. */
const listingPage = z.object({
  count: z.number(),
  next: z.string().nullable(),
  results: z.array(storedMemory),
});

/**
 * `POST /v3/memories/add/` with `infer: false`: synchronous, one result per
 * stored message. Without `results` the add was only queued (the `infer: true`
 * answer, `{ event_id, status: "PENDING" }`), which this integration never
 * asks for and reads as "accepted, not confirmed".
 */
const addAnswer = z.object({
  status: z.string().optional(),
  results: z
    .array(z.object({ id: z.string().min(1), data: z.object({ memory: z.string() }) }))
    .optional(),
});
type AddAnswer = z.infer<typeof addAnswer>;

/** `GET /v1/ping/`. Only `status` is always there; the rest is what the key resolves to. */
const pingAnswer = z.object({
  status: z.string(),
  org_id: z.string().optional(),
  project_id: z.string().optional(),
});
export type PingAnswer = z.infer<typeof pingAnswer>;

/** Mem0's error bodies: `{ detail }` for auth, `{ error, details: { message } }` for validation. */
const errorBody = z.object({
  detail: z.string().optional(),
  error: z.string().optional(),
  details: z.object({ message: z.string().optional() }).optional(),
});

/** What a filter selects, in Mem0's filter language (see memory.ts for which fields). */
export type Mem0Filters = Readonly<Record<string, unknown>>;

interface Mem0Message {
  readonly role: "user";
  readonly content: string;
}

export interface Mem0Client {
  /** One page of what `filters` selects, 1-indexed. */
  listPage(filters: Mem0Filters, page: number): Promise<{ memories: StoredMemory[]; count: number; more: boolean }>;
  /** Stores each message verbatim as one memory (Direct Import), tagged as given. */
  addVerbatim(input: {
    readonly messages: readonly Mem0Message[];
    readonly userId: string;
    readonly agentId: string;
    readonly appId: string;
    readonly metadata: Readonly<Record<string, string | boolean>>;
  }): Promise<AddAnswer>;
  /** Deletes one memory by id: `deleted`, or `missing` when Mem0 answered 404. */
  deleteById(id: string): Promise<"deleted" | "missing">;
}

export function mem0Client(ctx: Context): Mem0Client {
  let unreachable: string | null = null;

  async function send(path: string, init: { method: string; body?: unknown; query?: Record<string, string> }) {
    if (unreachable !== null) {
      throw new Mem0Failure("unavailable", `${unreachable} Memory was not asked again in this step.`);
    }
    const url = new URL(path, MEM0_API);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await ctx.http.fetch(url, {
        method: init.method,
        headers: {
          authorization: `Token ${ctx.connection.apiKey}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        timeoutMs: MEM0_ATTEMPT_MS,
        // Never resent: an add that may have landed would be stored twice, and
        // core asks again on the next step for anything that failed here.
        retries: 0,
      });
    } catch (error) {
      throw thrownFailure(error, (sentence) => {
        unreachable = sentence;
      });
    }
    return response;
  }

  async function answered<T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> {
    if (!response.ok) throw await statusFailure(response, what);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Mem0Failure("unavailable", `Mem0 answered ${what} in a shape this integration does not read.`);
    }
    return parsed.data;
  }

  return {
    async listPage(filters, page) {
      const response = await send("/v3/memories/", {
        method: "POST",
        body: { filters },
        query: { page: String(page), page_size: String(MEM0_PAGE_SIZE) },
      });
      const answer = await answered(response, listingPage, "a listing");
      return { memories: answer.results, count: answer.count, more: answer.next !== null };
    },

    async addVerbatim(input) {
      const response = await send("/v3/memories/add/", {
        method: "POST",
        body: {
          messages: input.messages,
          user_id: input.userId,
          agent_id: input.agentId,
          app_id: input.appId,
          metadata: input.metadata,
          // Stored as written, synchronously, and left out of Mem0's own
          // consolidation: core's model already distilled every item.
          infer: false,
          immutable: true,
        },
      });
      return answered(response, addAnswer, "an add");
    },

    async deleteById(id) {
      const response = await send(`/v1/memories/${encodeURIComponent(id)}/`, { method: "DELETE" });
      if (response.status === 404) return "missing";
      if (!response.ok) throw await statusFailure(response, "a delete");
      return "deleted";
    },
  };
}

/** `GET /v1/ping/`, for the connection test and the health probe, which read failures their own way. */
export async function ping(ctx: Context, timeoutMs: number): Promise<Response> {
  return ctx.http.fetch(new URL("/v1/ping/", MEM0_API), {
    headers: { authorization: `Token ${ctx.connection.apiKey}`, accept: "application/json" },
    timeoutMs,
    retries: 0,
  });
}

/** Reads a successful ping; null when the body is not Mem0's. */
export async function readPing(response: Response): Promise<PingAnswer | null> {
  const parsed = pingAnswer.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/**
 * A status Mem0 answered, as the port's word for it. Mem0 documents 400 and
 * 401 on its memory calls and 404 on a single memory; it documents no 429 and
 * no 5xx, so those are read by what HTTP says they mean.
 */
async function statusFailure(response: Response, what: string): Promise<Mem0Failure> {
  const status = response.status;
  if (status === 429) {
    const wait = response.headers.get("retry-after");
    return new Mem0Failure(
      "unavailable",
      `Mem0 rate limited ${what} (429)${wait ? `; it asked to wait ${wait} s` : ""}.`,
    );
  }
  if (readProviderFailure(response).kind === "no_verdict") {
    return new Mem0Failure("unavailable", `Mem0 did not complete ${what} (${status}).`);
  }
  if (status === 401 || status === 403) {
    return new Mem0Failure("rejected", `Mem0 refused the API key for ${what} (${status}).`);
  }
  const said = errorBody.safeParse(await response.json().catch(() => null));
  const words = said.success ? (said.data.details?.message ?? said.data.error ?? said.data.detail) : undefined;
  return new Mem0Failure(
    "rejected",
    `Mem0 refused ${what} (${status})${words ? `: ${words.slice(0, 200)}` : ""}.`,
  );
}

/**
 * A request that produced no status. `ctx.http` has already taken the key out
 * of the error's message; the sentence here does not quote it anyway.
 */
function thrownFailure(error: unknown, markUnreachable: (sentence: string) => void): Mem0Failure {
  const read = readProviderFailure(error);
  if (read.kind === "refused" && read.malformed) {
    return new Mem0Failure("rejected", "The Mem0 API key cannot be sent in a request; paste it again as one line.");
  }
  const name = error instanceof Error ? error.name : "";
  const sentence =
    name === "TimeoutError"
      ? `Mem0 did not answer within ${MEM0_ATTEMPT_MS / 1000} s.`
      : name === "AbortError"
        ? "The time this step gives memory ran out before Mem0 answered."
        : "Mem0 could not be reached.";
  markUnreachable(sentence);
  return new Mem0Failure("unavailable", sentence);
}
