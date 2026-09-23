/**
 * The agent's memory, as the dashboard and its MCP tools read and erase it.
 *
 * This decides what a request to read or erase memory MEANS, including the
 * refusals that are not about permission: a key pair that names nothing, a key
 * long enough to be a malformed or hostile request, and, since S13, a provider
 * that cannot enumerate what it holds.
 *
 * That last one is the reason this file is no longer a passthrough. Memory is
 * a capability with providers now, and a provider may implement the admin half
 * shallowly: an engine that can search but not list is perfectly usable for
 * runs. "It could not be listed" must never reach a screen as "there is
 * nothing here", so every answer below says which of the two it is.
 */
import { MEMORY_KEY_MAX_LENGTH } from "@shared/contracts";
import type { MemoryStoredDocument, MemoryStoredSummary } from "@integrations/sdk";
import { activeMemory } from "../../engine/support/memory-runtime.js";
import { BUILTIN_MEMORY_PROVIDER_ID } from "../../memory/builtin/adapter.js";

export type { MemoryStoredDocument, MemoryStoredSummary };

/**
 * Re-exported rather than re-declared: the MCP tool schemas bound the same two
 * strings from the contracts package, and two numbers here would let one
 * surface accept what the other rejects.
 */
export const MAX_MEMORY_KEY_LENGTH = MEMORY_KEY_MAX_LENGTH;

/** Whether a client-supplied key part is one the agent could have written. */
export function isUsableMemoryKeyPart(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_MEMORY_KEY_LENGTH
  );
}

/**
 * `listable: false` on any of the three answers below is NOT a failure: the
 * provider serves runs and simply cannot enumerate itself. It is a separate
 * field from `reason` for exactly that reason, and a caller that collapses
 * them tells an admin to fix a deployment that is working.
 */
export type MemoryListing =
  | {
      readonly ok: true;
      readonly documents: readonly MemoryStoredSummary[];
      /** False when the provider cannot promise this is everything it holds. */
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly reason: string; readonly listable: boolean };

export type MemoryRead =
  | { readonly ok: true; readonly document: MemoryStoredDocument | null }
  | { readonly ok: false; readonly reason: string; readonly listable: boolean };

export type MemoryErasure =
  | { readonly ok: true; readonly erased: boolean }
  | { readonly ok: false; readonly reason: string; readonly listable: boolean };

/** The listing, without content, optionally narrowed to one ticket or to one
 *  subject (compared exactly, by the provider where it lists). */
export async function listMemoryDocumentSummaries(options: {
  ticketKey?: string;
  subjectKey?: string;
}): Promise<MemoryListing> {
  const memory = await activeMemory();
  if (memory.refusal) {
    return { ok: false, reason: memory.refusal.detail, listable: true };
  }
  if (!memory.store) return { ok: false, reason: cannotList(memory.name), listable: false };
  try {
    const listing = await memory.store.list({
      ...(options.ticketKey === undefined ? {} : { ticketKey: options.ticketKey }),
      ...(options.subjectKey === undefined ? {} : { subjectKey: options.subjectKey }),
    });
    return { ok: true, documents: listing.documents, complete: listing.complete };
  } catch (error) {
    return { ok: false, reason: providerFailed(memory, error), listable: true };
  }
}

/** One document with its content. `document: null` means that pair names nothing. */
export async function readMemoryDocument(
  subjectKey: string,
  docPath: string,
): Promise<MemoryRead> {
  const memory = await activeMemory();
  if (memory.refusal) {
    return { ok: false, reason: memory.refusal.detail, listable: true };
  }
  if (!memory.store) return { ok: false, reason: cannotList(memory.name), listable: false };
  try {
    return { ok: true, document: await memory.store.read({ subjectKey, docPath }) };
  } catch (error) {
    return { ok: false, reason: providerFailed(memory, error), listable: true };
  }
}

/**
 * Erase one document.
 *
 * `erased: false` means nothing was there to erase, which the caller answers as
 * a miss rather than as a success: an erasure request that found nothing has
 * not been honoured, it has been answered about the wrong document. A provider
 * that could not be reached is `ok: false` and is a different answer again,
 * because telling somebody their data is gone when nobody deleted anything is
 * the worst of the three.
 */
export async function eraseMemoryDocument(
  subjectKey: string,
  docPath: string,
): Promise<MemoryErasure> {
  const memory = await activeMemory();
  if (memory.refusal) {
    return { ok: false, reason: memory.refusal.detail, listable: true };
  }
  if (!memory.store) return { ok: false, reason: cannotErase(memory.name), listable: false };
  try {
    return { ok: true, erased: await memory.store.forget({ subjectKey, docPath }) };
  } catch (error) {
    return { ok: false, reason: providerFailed(memory, error), listable: true };
  }
}

function cannotList(name: string): string {
  return `${name} keeps this deployment's memory and cannot list what it holds, so it cannot be browsed here. Read and erase it where that provider keeps it.`;
}

function cannotErase(name: string): string {
  return `${name} keeps this deployment's memory and cannot erase one document on request, so it cannot be erased here. Erase it where that provider keeps it.`;
}

/**
 * A provider that threw, with the next step, because a screen quoting this
 * has no other way to know it: waiting is the fix for a blip, and for an
 * integration that keeps failing the Integrations page is where its
 * connection is fixed. The built-in store is not on that page, so it gets
 * only the first half.
 */
function providerFailed(memory: { id: string | null; name: string }, error: unknown): string {
  const said = `${memory.name} could not answer: ${error instanceof Error ? error.message : String(error)}.`;
  return memory.id === BUILTIN_MEMORY_PROVIDER_ID
    ? `${said} Try again in a moment`
    : `${said} Try again in a moment, and if it keeps failing, check ${memory.name}'s connection on the Integrations page`;
}
