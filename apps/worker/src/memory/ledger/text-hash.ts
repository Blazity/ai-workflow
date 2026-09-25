import { repoMemoryComparisonKey } from "../repo-memory.js";

/**
 * The normalised text hash: what a forget matches by, what the ledger finds a
 * text's history by, and the alias an entry's state answers to.
 *
 * Normalised with the stores' own comparison key (`repoMemoryComparisonKey`),
 * so two spellings the stores treat as one entry hash as one, and without NUL
 * characters, which the ledger strips before it writes. Web Crypto rather than
 * `node:crypto`, so importing this reaches no Node module.
 */
export async function memoryTextHash(text: string): Promise<string> {
  const normalised = repoMemoryComparisonKey(text.replaceAll("\u0000", ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalised));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
