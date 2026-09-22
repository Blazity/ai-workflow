/**
 * The worker half of the example integration: the code behind manifest.ts.
 * May import @integrations/sdk and ./manifest only. No "use step" directive
 * belongs anywhere in this file; core runs every block in its own generic
 * integration step, which is what keeps a moved or renamed integration from
 * stranding a run.
 */
import {
  defineIntegrationRuntime,
  FatalError,
  readProviderFailure,
  refusedOrThrow,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { manifest } from "./manifest";

type ExampleManifest = typeof manifest;

/**
 * Keep the annotation. Written inline as the second argument of
 * defineIntegrationRuntime, TypeScript stops typing the health probes'
 * arguments from the manifest and they arrive as `any`; annotated here, every
 * block, adapter and probe is checked against what the manifest declares.
 */
const definition: IntegrationRuntimeDefinition<ExampleManifest> = {
  testConnection: async (ctx) => {
    const response = await ctx.http.fetch(new URL("/me", ctx.connection.baseUrl), {
      headers: { authorization: `Bearer ${ctx.connection.apiToken}` },
      signal: ctx.signal,
      timeoutMs: 5_000,
    });
    if (response.ok) return { ok: true };
    // A 401 is the provider refusing the token; a 503 or a timeout says
    // nothing about it. `refusedOrThrow` returns the first and throws the
    // second, which is what keeps an outage from turning the card Failing.
    return refusedOrThrow(response, `The provider refused the API token (${response.status}).`);
  },
  capabilities: {},
  blocks: {
    example_ping: async ({ params }, ctx) => {
      const response = await ctx.http.fetch(new URL("/ping", ctx.connection.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.connection.apiToken}` },
        body: JSON.stringify({ message: params.message }),
      });
      if (!response.ok) {
        // The SDK's rule, not a status list of this block's own: a refusal
        // (401 a token, 403 a permission, 404 a thing that is not there, a 400
        // about the request) cannot succeed on a retry, and FatalError is how
        // an integration says so. A 5xx, a 408 or a rate limit said nothing
        // about the values, and core may try again.
        if (readProviderFailure(response).kind === "refused") {
          throw new FatalError(`The example provider refused the request (${response.status}).`);
        }
        return {
          kind: "failed",
          message: "The example provider did not answer.",
          detail: `status ${response.status}`,
        };
      }
      const body = (await response.json()) as { reply: string };
      ctx.log.info({ status: response.status }, "example_ping_sent");
      return { kind: "next", output: { status: "ok", reply: body.reply } };
    },
  },
  health: {
    auth: async (ctx) => {
      const response = await ctx.http.fetch(new URL("/me", ctx.connection.baseUrl), {
        signal: ctx.signal,
        retries: 0,
      });
      if (response.ok) return { status: "live" };
      // Down either way, because the check did not pass; the sentence is what
      // differs. A refusal sends the admin to the token, an answer that says
      // nothing about it sends them to wait (see `IntegrationHealthResult`).
      return readProviderFailure(response).kind === "refused"
        ? { status: "down", message: `The provider refused the API token (${response.status}).` }
        : {
            status: "down",
            message: `The provider did not answer, so the token could not be checked (${response.status}).`,
          };
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
