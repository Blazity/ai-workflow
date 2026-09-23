/**
 * Taking this deployment's secrets out of memory text: the rule and its one
 * implementation.
 *
 * Two callers, each doing what only it can:
 *
 * - The port wrapper (`withoutKnownSecrets` in
 *   `engine/support/memory-runtime.ts`) cleans every observation before any
 *   provider sees it, the built-in store included. A provider cannot do this
 *   itself: a token an admin stored in the dashboard is decrypted from core's
 *   database and never reaches the environment.
 * - The built-in store (`memory/builtin/adapter.ts`) cleans the items it
 *   ALREADY holds before it merges into them. A value stored before it became
 *   a known secret (an environment variable added later, a token pasted into
 *   the dashboard later) is taken out at the next write, which is what this
 *   store has always done by re-rendering the whole document. No wrapper can
 *   reach stored text, and a hosted engine's stored text is its own.
 *
 * FAILS CLOSED, and says which way: a secret set that cannot be read is
 * `unavailable` (the same write may go through on a later step), text the
 * redaction could not process is `rejected` (it would fail the same way
 * again). The caller writes nothing in either case.
 *
 * Workflow-scope safe: both the secret source and the redaction are deferred
 * imports, so importing this module reaches no Node module.
 */
import type { MemoryWrite } from "@integrations/sdk";

export type KnownSecretsTakenOut<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: Extract<MemoryWrite, { ok: false }> };

/**
 * Reads the secrets this deployment knows and hands `apply` a cleaner for
 * them. `apply` builds whatever the caller needs from cleaned text; a throw
 * from the cleaner inside it is the `rejected` refusal.
 */
export async function takeOutKnownSecrets<T>(
  apply: (clean: (text: string) => string) => T,
): Promise<KnownSecretsTakenOut<T>> {
  let secrets: readonly string[];
  try {
    const { knownSecretValues } = await import("../services/integrations/runtime.js");
    secrets = await knownSecretValues();
  } catch (error) {
    // The source's own message is fixed and names no database detail.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "unavailable",
        detail: `${reason} So nothing was written to memory.`,
      },
    };
  }
  if (secrets.length === 0) return { ok: true, value: apply((text) => text) };
  const { redactConfiguredSecretsInText } = await import("../run-observability/sanitizer.js");
  try {
    return { ok: true, value: apply((text) => redactConfiguredSecretsInText(text, secrets)) };
  } catch {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "rejected",
        detail: "the text could not be scrubbed of this deployment's secrets, so it was not stored",
      },
    };
  }
}
