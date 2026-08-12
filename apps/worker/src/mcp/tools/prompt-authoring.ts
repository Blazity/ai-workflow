import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { builtInPromptNameForSlug } from "../../prompt-library/builtin-prompts.js";
import {
  getCurrentPromptVersion,
  getPrompt,
  PromptLibraryStoreError,
  savePromptVersion,
} from "../../prompt-library/store.js";
import type { McpToolDependencies } from "../contracts.js";
import { executeMcpMutation } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { registerCatalogTool } from "../tool-catalog.js";
import { refusal, storeActor } from "./authoring-support.js";

/**
 * The first authoring mutation on this surface, and the one that deserves the most
 * suspicion: a prompt body is the instruction set every future run is handed, so a
 * client that can write one can change how other agents behave from then on. Four
 * separate locks sit in front of it and each one is here for its own reason:
 * a scope of its own (contracts.ts:4), a role list without "service" (policy.ts),
 * a refusal for built-in prompts, and a compare-and-set on the version.
 */

type PromptUpdateData = {
  promptId: number;
  slug: string;
  version: number;
  // False when the body was byte-identical to the head: savePromptVersion stores
  // no second copy of the same text (store.ts:681), so `version` is then still the
  // version the caller sent as expectedVersion. Without this field that answer is
  // indistinguishable from a write that did not happen.
  changed: boolean;
  bodyHash: string;
};

/** The identity of an edit: which prompt, which version it replaces, and the text
 * that replaces it, hashed. This value becomes the audit row's inputHash
 * (execute-tool.ts:291), and a prompt body is precisely what an operator does not
 * want to find sitting in an audit table for a year, so it is hashed and never
 * carried. The idempotency key is deliberately outside the hash: it is the thing
 * this payload is compared FOR, so folding it in would make every key agree with
 * itself and "same key, different edit" undetectable. */
function updatePayloadHash(identity: {
  promptId: number;
  expectedVersion: number;
  body: string;
}): string {
  return `sha256:${hashCanonicalJson(identity)}`;
}

/** Over the canonical JSON of the body, the same rule everything else in this
 * module hashes by, so an agent can reproduce it from the bytes it sent. */
function bodyDigest(body: string): string {
  return `sha256:${hashCanonicalJson(body)}`;
}

/** The store's own refusals, mapped onto codes an agent can act on and forwarded
 * with their messages, which are fixed strings the dashboard already shows people.
 * Only the two statuses a save can still reach are mapped: 400 is unreachable
 * because the catalog schema already enforces the body bounds the store checks and
 * this tool sends no slots, and both mapped ones leave the library untouched (404
 * is the prompt disappearing under us, 409 is either an archive or a version
 * number another writer took, and store.ts:691 only reaches that 409 once the
 * unique index has rejected every insert). Anything else is rethrown as it is, so
 * the wrapper seals the key and hides the text: an unexpected failure may have
 * left the version written. */
function throwPublicStoreError(error: unknown): never {
  if (error instanceof PromptLibraryStoreError) {
    if (error.statusCode === 404) throw refusal("NOT_FOUND", error.message);
    if (error.statusCode === 409) throw refusal("CONFLICT", error.message, true);
  }
  throw error;
}

export function registerPromptAuthoringTools(
  server: McpServer,
  deps: McpToolDependencies,
): void {
  registerCatalogTool(
    server,
    "prompts.update",
    async (input) => {
      const envelope = await executeMcpMutation({
        deps,
        toolName: "prompts.update",
        // Which prompt, and which version the edit replaces. Never the body:
        // targetRefs are stored verbatim (audit-store.ts:58), and the only record
        // this tool leaves of the text is a digest.
        targetRefs: [String(input.promptId), String(input.expectedVersion)],
        idempotencyKey: input.idempotencyKey,
        payloadHash: updatePayloadHash({
          promptId: input.promptId,
          expectedVersion: input.expectedVersion,
          body: input.body,
        }),
        operation: async (): Promise<PromptUpdateData> => {
          const prompt = await getPrompt(deps.db, input.promptId);
          if (!prompt) throw refusal("NOT_FOUND", "Prompt not found");

          // Identity first, before staleness: a built-in prompt is refused for
          // what it IS, and telling such a caller to re-read the version would
          // send it round a loop that can never end in a write. The slug is the
          // marker, the same one the drift report resolves the shipped constant
          // through (builtin-prompt-drift.ts:629) and the same one a resync
          // migration targets, so the three cannot disagree about which rows are
          // the platform's.
          if (builtInPromptNameForSlug(prompt.slug) !== null) {
            throw refusal(
              "FORBIDDEN",
              `"${prompt.slug}" is a built-in platform prompt. Its text ships with the deployment and is changed by a resync migration, never through MCP: an edit here would either fail the built-in prompt drift gate or leave every run pinned to version 1 still reading the shipped text.`,
            );
          }
          // Distinct from the store's own 409 on the same state, and not
          // retryable: an archived prompt stays archived until somebody restores
          // it, so coming back with the same call cannot help.
          if (prompt.archivedAt !== null) {
            throw refusal(
              "CONFLICT",
              "Prompt is archived: restore it before editing it.",
            );
          }

          const head = await getCurrentPromptVersion(deps.db, input.promptId);
          if (!head) throw refusal("NOT_FOUND", "Prompt has no current version");
          // Compare-and-set, and knowingly not atomic: savePromptVersion takes no
          // expected version (store.ts:651) and neon-http has no interactive
          // transactions, so this read and the insert are two statements. What it
          // buys is a narrow window instead of none: two agents editing from the
          // same head now collide here rather than stacking two versions where the
          // last writer's text silently becomes what every run gets. What remains
          // is a save landing between this check and ours, and that one is still
          // recorded as its own version with neither body lost.
          if (head.version !== input.expectedVersion) {
            throw refusal(
              "CONFLICT",
              `Prompt ${input.promptId} is at version ${head.version}, not ${input.expectedVersion}. Read it again with prompts.get and re-send the edit against the version you have seen.`,
            );
          }

          // Outside the try below, so a refused role cannot be read as a failure
          // of the store.
          const actor = storeActor(deps.actor);
          let saved: Awaited<ReturnType<typeof savePromptVersion>>;
          try {
            saved = await savePromptVersion(deps.db, {
              promptId: input.promptId,
              body: input.body,
              // Slots left alone on purpose: passing none carries the head's slots
              // over unchanged (store.ts:677), and editing a prompt's slot
              // contract is a different decision from editing its text.
              actor,
            });
          } catch (error) {
            throwPublicStoreError(error);
          }
          // The body is not echoed. This value is stored as the idempotency key's
          // response for its whole lifetime and hashed into the audit row's
          // outputHash, and the prompt text belongs in neither.
          return {
            promptId: prompt.id,
            slug: prompt.slug,
            version: saved.version.version,
            changed: saved.changed,
            bodyHash: bodyDigest(input.body),
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
