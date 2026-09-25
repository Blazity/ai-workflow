/**
 * The normalised text hash: what a forget matches by, what the ledger finds a
 * text's history by, and the alias an entry's state answers to.
 *
 * A copy, character for character, of `normalizeMemoryText` and
 * `memoryTextHash` in `integrations/sdk/memory.ts` as the store port v2 adds
 * them, so every hash stored here equals the one the stores forget by. When
 * that port is on main, this file becomes a re-export of its `memoryTextHash`
 * and no stored hash changes. Web Crypto rather than `node:crypto`, so importing this
 * reaches no Node module.
 */

/**
 * The comparison form of an entry's text: two texts are the same entry exactly
 * when these are equal. NUL characters go (no stored text can hold one),
 * surrounding whitespace, leading list markers and one final full stop go,
 * inner whitespace collapses to one space, the rest is lower-cased, and the
 * result is in Unicode NFC, so an accent typed as a combining mark matches
 * the precomposed one.
 */
function normalizeMemoryText(text: string): string {
  return text
    .replaceAll("\u0000", "")
    .normalize("NFC")
    .trim()
    .replace(/^(?:[-*]\s+)+/, "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim()
    .toLowerCase()
    .normalize("NFC");
}

/** SHA-256 of the UTF-8 bytes of `normalizeMemoryText(text)`, as 64 lowercase hex digits. */
export async function memoryTextHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeMemoryText(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
