/**
 * The code behind manifest.ts: the connection test, one executor per declared
 * block, one probe per declared health check, and what the Overview page reads.
 *
 * Server only, and it may use Node and any provider SDK this package declares.
 * It carries no `"use step"` or `"use workflow"` directive: core runs every
 * block inside one step it owns, which is what keeps a moved or renamed
 * integration from stranding a suspended run, and the registry's conformance
 * suite refuses a directive anywhere in the package.
 */
import {
  defineIntegrationRuntime,
  readProviderFailure,
  refusedOrThrow,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
  z,
} from "@integrations/sdk";
import { manifest } from "./manifest";

type ThisManifest = typeof manifest;
type Context = IntegrationContext<ThisManifest>;

/** The account the token belongs to, as the provider answers `GET /v1/me`. */
const accountAnswer = z.object({ name: z.string(), plan: z.string() });

/** A search, as the provider answers `GET /v1/search`. Read, never trusted. */
const searchAnswer = z.object({
  total: z.number(),
  items: z.array(z.object({ title: z.string() })),
});

function authorization(ctx: Context): Record<string, string> {
  return { authorization: `Bearer ${ctx.connection.apiToken}` };
}

/** The body as JSON, or null when the provider sent something else. */
async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/**
 * Keep this annotation. Written inline as the second argument of
 * `defineIntegrationRuntime`, TypeScript stops typing the health probes from
 * the manifest: their `ctx` becomes an implicit `any` and a returned status
 * widens to `string`.
 */
const definition: IntegrationRuntimeDefinition<ThisManifest> = {
  /**
   * Runs before stored values become the active connection, and when an admin
   * presses Test. Return `{ ok: false }` only when the provider has said the
   * credential is wrong: that marks the connection Failing and stops every run
   * that needs it. Throw for anything else (a timeout, a 5xx, a body that is
   * not the provider's): core reads a throw as "could not be reached" and leaves
   * a working connection alone.
   */
  testConnection: async (ctx) => {
    const response = await ctx.http.fetch(new URL("/v1/me", ctx.connection.baseUrl), {
      headers: authorization(ctx),
      retries: 0,
    });
    if (!response.ok) {
      // A 401 is the provider refusing the token; a 503, a 429 or a timeout
      // says nothing about it. `refusedOrThrow` returns the first and throws
      // the second, which keeps an outage from turning the card Failing.
      return refusedOrThrow(response, `Example refused the API token (${response.status}).`);
    }
    const account = accountAnswer.safeParse(await json(response));
    if (!account.success) {
      throw new Error(`${ctx.connection.baseUrl} did not answer the way the Example API does.`);
    }
    return { ok: true, message: `Connected as ${account.data.name}.` };
  },

  capabilities: {},

  blocks: {
    /**
     * Core runs this once and never again: an executor that started is not
     * retried, so a request that writes something is not repeated. `failed` is
     * an expected failure a person reads on the run and in the ticket comment;
     * a throw is reported the same way with the error's own message.
     */
    example_lookup: async ({ params, inputs }, ctx) => {
      const url = new URL("/v1/search", ctx.connection.baseUrl);
      url.searchParams.set("q", inputs.query);
      url.searchParams.set("limit", String(params.limit));
      const response = await ctx.http.fetch(url, { headers: authorization(ctx) });
      if (!response.ok) {
        // The SDK's rule decides which sentence is true: a refusal sends a
        // person to the token or the query, anything else to try again later.
        return {
          kind: "failed",
          message:
            readProviderFailure(response).kind === "refused"
              ? `Example refused the search (${response.status}).`
              : `Example did not answer the search (${response.status}); try again later.`,
        };
      }
      const answer = searchAnswer.safeParse(await json(response));
      if (!answer.success) {
        return {
          kind: "failed",
          message: "Example answered the search in a shape this integration does not read.",
        };
      }
      const matches = answer.data.total;
      ctx.log.info({ matches }, "example_lookup_answered");
      if (matches === 0) {
        return {
          kind: "next",
          output: { status: "nothing_found", summary: `Nothing matched "${inputs.query}".`, matches },
        };
      }
      return {
        kind: "next",
        output: {
          status: "found",
          summary: answer.data.items.map((item) => item.title).join("\n"),
          matches,
        },
      };
    },
  },

  health: {
    /** Core gives a probe about four seconds, so it asks once and does not retry. */
    api: async (ctx) => {
      const response = await ctx.http.fetch(new URL("/v1/me", ctx.connection.baseUrl), {
        headers: authorization(ctx),
        retries: 0,
        timeoutMs: 3_000,
      });
      if (response.ok) return { status: "live" };
      // Down either way, because the check did not pass; the sentence is what
      // differs. A refusal sends the admin to the token, an answer that says
      // nothing about it sends them to wait (see `IntegrationHealthResult`).
      return readProviderFailure(response).kind === "refused"
        ? { status: "down", message: `Example refused the API token (${response.status}).` }
        : {
            status: "down",
            message: `Example did not answer, so the token could not be checked (${response.status}).`,
          };
    },
  },

  /**
   * What each page reads, keyed by page id. Core calls it on the server and
   * hands the page the result as `data`, which reaches the browser: return
   * nothing a person could not be shown. A throw reaches the page as the
   * provider being unavailable, with the error's message, redacted.
   */
  api: {
    overview: async (ctx) => {
      const response = await ctx.http.fetch(new URL("/v1/me", ctx.connection.baseUrl), {
        headers: authorization(ctx),
      });
      if (!response.ok) throw new Error(`Example answered ${response.status}.`);
      const account = accountAnswer.safeParse(await json(response));
      if (!account.success) throw new Error("Example answered in a shape this page does not read.");
      return { name: account.data.name, plan: account.data.plan };
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
