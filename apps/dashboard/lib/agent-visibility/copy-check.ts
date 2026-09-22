/**
 * Before a section is copied: are the loaded pages exactly the bytes the worker
 * stored? The copy is only offered when they are, so a person pasting the
 * prompt somewhere never pastes a page short, a page twice, or text a proxy
 * rewrote.
 */

export type StoredTextCheck =
  | { ok: true; text: string; digestChecked: boolean }
  | { ok: false; message: string };

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkStoredText(
  pages: readonly { text: string }[],
  stored: { storedBytes: number; storedSha256: string },
): Promise<StoredTextCheck> {
  const text = pages.map((page) => page.text).join("");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length !== stored.storedBytes) {
    return {
      ok: false,
      message: `The loaded text is ${bytes.length} bytes and the worker stored ${stored.storedBytes}, so nothing was copied.`,
    };
  }
  const subtle = globalThis.crypto?.subtle;
  // Web Crypto exists only on secure origins; the length still held.
  if (!subtle) return { ok: true, text, digestChecked: false };
  const digest = hex(await subtle.digest("SHA-256", bytes));
  if (digest !== stored.storedSha256) {
    return { ok: false, message: "The loaded text does not match the digest the worker stored, so nothing was copied." };
  }
  return { ok: true, text, digestChecked: true };
}
