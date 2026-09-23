/**
 * The code behind manifest.ts: the connection test, the memory adapter and the
 * health probe. No block, no page and no webhook: Mem0 serves memory, which
 * core calls around a run.
 */
import {
  defineIntegrationRuntime,
  readProviderFailure,
  refusedOrThrow,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { MEM0_ATTEMPT_MS, ping, readPing } from "./client";
import { manifest } from "./manifest";
import { mem0Memory } from "./memory";

/**
 * A key for a self-hosted Mem0 server (its dashboard issues `m0sk_...` keys,
 * sent as `X-API-Key`; docs.mem0.ai/open-source/features/rest-api). This
 * integration talks to the hosted platform, which would answer 401 without
 * saying why, so such a key is recognised and never sent there.
 */
const SELF_HOSTED_KEY_PREFIX = "m0sk_";

const definition: IntegrationRuntimeDefinition<typeof manifest> = {
  /**
   * `GET /v1/ping/` is the call Mem0's own SDKs make to validate a key, and
   * the one that names the organization and project the key resolves to. It
   * answers 401 for a key it does not accept (documented, and seen live on
   * 2026-09-23); a 429, a 5xx or a timeout says nothing about the key and
   * throws, which leaves a working connection as it was.
   */
  testConnection: async (ctx) => {
    const key = ctx.connection.apiKey;
    if (key.startsWith(SELF_HOSTED_KEY_PREFIX)) {
      return {
        ok: false,
        reason:
          "This is a key for a self-hosted Mem0 server (it starts with m0sk_). This integration talks to Mem0's hosted platform: use an API key from app.mem0.ai.",
      };
    }
    if (/\s/u.test(key)) {
      return {
        ok: false,
        reason: "The API key has a space or a line break in it. Copy it again from Mem0 as one line.",
        malformed: true,
      };
    }
    let response: Response;
    try {
      response = await ping(ctx, MEM0_ATTEMPT_MS);
    } catch (error) {
      return refusedOrThrow(error);
    }
    if (!response.ok) {
      return refusedOrThrow(response, `Mem0 refused this API key (${response.status}).`);
    }
    const answer = await readPing(response);
    if (!answer) throw new Error("api.mem0.ai did not answer the way the Mem0 API does.");
    if (answer.org_id && answer.project_id) {
      return {
        ok: true,
        message: `Mem0 accepted the key. It writes into organization ${answer.org_id}, project ${answer.project_id} (Mem0's ids; compare them with the project in the Mem0 dashboard before any run uses it).`,
      };
    }
    return {
      ok: true,
      message:
        "Mem0 accepted the key but did not say which organization and project it belongs to. Check in the Mem0 dashboard that the key was made for the project you mean.",
    };
  },

  capabilities: {
    memory: mem0Memory,
  },

  blocks: {},

  health: {
    /** Core gives a probe about four seconds, so it asks once. */
    api: async (ctx) => {
      const response = await ping(ctx, 3_000);
      if (response.ok) return { status: "live" };
      return readProviderFailure(response).kind === "refused"
        ? { status: "down", message: `Mem0 refused the API key (${response.status}).` }
        : { status: "down", message: `Mem0 did not answer, so the key could not be checked (${response.status}).` };
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
