/**
 * Taking this deployment's secrets out of memory text: the rule and its one
 * implementation.
 *
 * Three callers, each doing what only it can:
 *
 * - The port wrapper cleans every observation before any provider sees it,
 *   the built-in store included (`withoutKnownSecrets` in
 *   `engine/support/memory-runtime.ts`). A provider cannot do this itself: a
 *   token an admin stored in the dashboard is decrypted from core's database
 *   and never reaches the environment.
 * - The port wrapper cleans every recalled `rendering` before it reaches a
 *   prompt or a workspace (`renderingWithoutKnownSecrets`, same file). A
 *   provider can hold a value stored before it became a known secret, and
 *   nothing else stands between it and the prompt.
 * - The built-in store cleans the items it ALREADY holds before it merges into
 *   them (`heldItems` in `memory/builtin/adapter.ts`), so a value stored before
 *   it became a known secret leaves the row at the next write, which is what
 *   this store always did by re-rendering the whole document.
 *
 * FAILS CLOSED: a secret set that cannot be read, or text the redaction cannot
 * process, is a refusal, and the caller sends, stores or uses nothing.
 *
 * Workflow-scope safe: the secret source and the redaction are deferred
 * imports, so importing this module reaches no Node module.
 */
import type { MemoryWrite } from "@integrations/sdk";

/** A cleaner for the secrets this deployment knows, or that they could not be read. */
export type KnownSecretCleaner =
  | { readonly ok: true; readonly clean: (text: string) => string }
  | { readonly ok: false };

export type KnownSecretsTakenOut<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly why: "unreadable" | "unscrubbable" };

/**
 * The fixed words for a set that could not be read. Never an error's own
 * message: only the connection source fixes its message, and anything else
 * that throws on the way could carry a database detail into a refusal that a
 * trace, a log and MCP all repeat.
 */
export const KNOWN_SECRETS_UNREADABLE = "this deployment's secrets could not be read";

/** Reads the secrets this deployment knows, once, into a cleaner. */
export async function readKnownSecretCleaner(): Promise<KnownSecretCleaner> {
  try {
    const { knownSecretValues } = await import("../services/integrations/runtime.js");
    const secrets = await knownSecretValues();
    if (secrets.length === 0) return { ok: true, clean: (text) => text };
    const { redactConfiguredSecretsInText } = await import("../run-observability/sanitizer.js");
    return { ok: true, clean: (text) => redactConfiguredSecretsInText(text, secrets) };
  } catch {
    return { ok: false };
  }
}

/** How a caller gets the set: one read, shared, for as long as it is kept. */
export type KnownSecretsReader = () => Promise<KnownSecretCleaner>;

/**
 * The set, read at most once for as long as this reader is kept, which is one
 * step: `activeMemory` makes one per resolution and hands the same reader to
 * the port wrapper and to the built-in store, so a step reads the connection
 * tables once whatever it recalls and writes. A read that failed is not kept:
 * the next call tries again.
 */
export function knownSecretsReader(): KnownSecretsReader {
  let cleaner: Promise<KnownSecretCleaner> | undefined;
  return async () => {
    cleaner ??= readKnownSecretCleaner();
    const read = await cleaner;
    if (!read.ok) cleaner = undefined;
    return read;
  };
}

/**
 * Hands `apply` the cleaner and returns what it built from cleaned text. A
 * throw from the cleaner inside `apply` is `unscrubbable`. The set is read
 * here unless the caller already holds a read of it.
 */
export async function takeOutKnownSecrets<T>(
  apply: (clean: (text: string) => string) => T,
  cleaner: KnownSecretCleaner | Promise<KnownSecretCleaner> = readKnownSecretCleaner(),
): Promise<KnownSecretsTakenOut<T>> {
  const read = await cleaner;
  if (!read.ok) return { ok: false, why: "unreadable" };
  try {
    return { ok: true, value: apply(read.clean) };
  } catch {
    return { ok: false, why: "unscrubbable" };
  }
}

/**
 * A write refused because its text could not be cleaned, and which way:
 * `unavailable` when the set could not be read (the same write may go through
 * on a later step), `rejected` when the text itself could not be processed (it
 * would fail the same way again).
 */
export function unscrubbedWrite(
  why: "unreadable" | "unscrubbable",
): Extract<MemoryWrite, { ok: false }> {
  return why === "unreadable"
    ? {
        ok: false,
        code: "unavailable",
        detail: `${KNOWN_SECRETS_UNREADABLE}, so nothing was written to memory`,
      }
    : {
        ok: false,
        code: "rejected",
        detail: "the text could not be scrubbed of this deployment's secrets, so it was not stored",
      };
}
