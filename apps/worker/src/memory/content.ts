/**
 * Content rules shared by every agent memory document, whichever scope writes
 * it. Reachable from workflow scope, so no Node builtins at module scope:
 * TextEncoder/TextDecoder only, never Buffer.
 */
const TRUNCATION_MARKER = "<!-- truncated by blazebot memory store -->";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * What the built-in store writes for a document: NUL removed, because Postgres
 * text rejects it outright (the driver throws a raw error), then capped on the
 * bytes that actually get stored. Everything else stays verbatim, because the
 * agent reads this document back.
 *
 * Secrets are not this module's: every observation reaches a provider with
 * them already taken out, in one place for every provider
 * (`withoutKnownSecrets` in `engine/support/memory-runtime.ts`).
 */
export function prepareMemoryContent(
  raw: string,
  maxBytes: number,
  sourceTruncated: boolean,
): { content: string; truncated: boolean } {
  const content = raw.replace(/\0/g, "");
  if (!sourceTruncated && utf8Bytes(content) <= maxBytes) {
    return { content, truncated: false };
  }
  const suffix = `\n${TRUNCATION_MARKER}`;
  const head = sliceUtf8Head(content, maxBytes - utf8Bytes(suffix));
  return { content: `${head}${suffix}`, truncated: true };
}

/**
 * The line core ends memory with when it had to cut it to fit: in words,
 * because a model or an agent reads it, and on a line of its own, so it never
 * reads as an entry. Text that ends without it is whole.
 */
export const MEMORY_CUT_MARKER = "[memory cut here: the rest was over the size limit and was left out]";

/**
 * Below this much room, a cut section would be little more than its heading
 * and the marker, which costs a prompt tokens and tells the model nothing, so
 * the text is left out instead and its caller counts that.
 */
const MIN_CUT_BYTES = 1024;

/**
 * `text` fitted to `maxBytes` of UTF-8, for memory core puts in front of a
 * model or into an agent's workspace. THE ONE RULE for cutting memory, so a
 * cut reads the same wherever it happens.
 *
 * Whole when it fits. Otherwise cut and ended with `MEMORY_CUT_MARKER` on its
 * own line, the marker included in `maxBytes`: at the last line end inside the
 * room, so no entry is split, unless that would keep less than half the room
 * (one line longer than that, which is a single oversized entry or a document
 * written as one paragraph), in which case inside that line at a character
 * boundary. Null when it does not fit and less than `MIN_CUT_BYTES` of room
 * is left.
 */
export function fitMemoryText(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly cut: boolean } | null {
  if (utf8Bytes(text) <= maxBytes) return { text, cut: false };
  if (maxBytes < MIN_CUT_BYTES) return null;
  const suffix = `\n${MEMORY_CUT_MARKER}`;
  const room = maxBytes - utf8Bytes(suffix);
  const head = sliceUtf8Head(text, room);
  const lineEnd = head.lastIndexOf("\n");
  const kept =
    lineEnd >= 0 && utf8Bytes(head.slice(0, lineEnd)) >= room / 2 ? head.slice(0, lineEnd) : head;
  return { text: `${kept.trimEnd()}${suffix}`, cut: true };
}

export function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function sliceUtf8Head(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = utf8Encoder.encode(value);
  return utf8Decoder.decode(encoded.subarray(0, utf8BoundaryEnd(encoded, maxBytes)));
}

/** Largest cut at or below maxBytes that does not split a character: UTF-8
 * continuation bytes are 0b10xxxxxx, so walk back off them. */
export function utf8BoundaryEnd(bytes: Uint8Array, maxBytes: number): number {
  if (bytes.byteLength <= maxBytes) return bytes.byteLength;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return end;
}
