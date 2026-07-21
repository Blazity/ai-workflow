/** 32-bit FNV-1a hash over the string's UTF-16 code units, returned as
 *  lowercase hex. Dependency-free; used to fingerprint inserted prompt text so
 *  the editor can detect a later manual edit of a library-sourced field. */
export function fnv1a(text: string): string {
  // FNV offset basis (32-bit).
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    // XOR the current 16-bit code unit, then multiply by the 32-bit FNV prime.
    // Math.imul keeps the multiply in 32-bit two's-complement space.
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to an unsigned 32-bit value before formatting as hex.
  return (hash >>> 0).toString(16);
}
