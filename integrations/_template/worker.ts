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
    return { ok: false, reason: await response.text() };
  },
  capabilities: {},
  blocks: {
    example_ping: async ({ params }, ctx) => {
      const response = await ctx.http.fetch(new URL("/ping", ctx.connection.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.connection.apiToken}` },
        body: JSON.stringify({ message: params.message }),
      });
      if (response.status === 401) {
        // Retrying with the same token cannot succeed, and FatalError is how
        // an integration says so; everything else core may retry.
        throw new FatalError("The example provider refused the API token.");
      }
      if (!response.ok) {
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
      return {
        status: response.status === 401 ? "down" : "degraded",
        message: `The provider answered ${response.status}.`,
      };
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
