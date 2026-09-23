import { redactConfiguredSecretsInText } from "../run-observability/sanitizer.js";

/**
 * Content rules shared by every agent memory document, whichever scope writes
 * it. Reachable from workflow scope, so no Node builtins at module scope:
 * TextEncoder/TextDecoder only, never Buffer.
 */
const TRUNCATION_MARKER = "<!-- truncated by blazebot memory store -->";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Order matters: Postgres text rejects NUL outright (the driver throws a raw
 * error), redaction changes the byte count, so the cap is measured last on the
 * bytes that actually get stored. Only configured secrets are rewritten, because
 * the agent reads this document back and everything else has to stay verbatim.
 *
 * `secrets` is every secret the deployment knows (`knownSecretValues`), which
 * the writer resolves: a document is written from a step, and a token an admin
 * stored in the dashboard is not in the environment for this module to find.
 */
export function prepareMemoryContent(
  raw: string,
  maxBytes: number,
  sourceTruncated: boolean,
  secrets: readonly string[],
): { content: string; truncated: boolean } | null {
  let content: string;
  try {
    content = redactConfiguredSecretsInText(raw.replace(/\0/g, ""), secrets);
  } catch {
    return null;
  }
  if (!sourceTruncated && utf8Bytes(content) <= maxBytes) {
    return { content, truncated: false };
  }
  const suffix = `\n${TRUNCATION_MARKER}`;
  const head = sliceUtf8Head(content, maxBytes - utf8Bytes(suffix));
  return { content: `${head}${suffix}`, truncated: true };
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
