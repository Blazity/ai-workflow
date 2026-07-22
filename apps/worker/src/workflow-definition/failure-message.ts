import type { ExecutionErrorCategory } from "./interpreter.js";

/** Longest single-line snippet of raw `detail` we append to a user-facing
 * failure message. Keeps Slack messages and Jira comments compact. */
const SNIPPET_MAX_LENGTH = 120;

const REDACTED = "[redacted]";

/** Curated (pattern, message) rules for provider-category failures. The first
 * match wins, so order them from the most to the least specific cause. Each
 * message names the cause and the fix without echoing the raw provider
 * payload, so it is safe for Slack and client-visible Jira comments. */
const PROVIDER_CAUSES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /credit balance|billing|insufficient.*(credit|quota|funds)/i,
    message:
      "The AI provider rejected the request: the account credit or billing balance is too low.",
  },
  {
    pattern: /rate.?limit|429|too many requests/i,
    message: "The AI provider rate-limited the request. Please retry shortly.",
  },
  {
    pattern:
      /401|unauthorized|authentication|invalid.*(api.?key|x-api-key)|permission denied/i,
    message:
      "The AI provider rejected the credentials (authentication failed). Check the API key.",
  },
  {
    pattern: /model.*(not found|does not exist|access|not allowed)/i,
    message: "The requested AI model is unavailable or access is denied.",
  },
  {
    pattern: /529|overloaded/i,
    message: "The AI provider is overloaded. Please retry shortly.",
  },
];

/** Match `detail` against the curated provider causes, returning the safe
 * message for the first hit, or undefined when nothing matches. */
export function classifyProviderFailure(detail: string): string | undefined {
  for (const { pattern, message } of PROVIDER_CAUSES) {
    if (pattern.test(detail)) return message;
  }
  return undefined;
}

/** Drop stack-trace frames ("at fn (file:line:col)") that would leak internal
 * paths and add no operator value. */
function stripStackFrames(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*at\s+.+/.test(line))
    .join("\n");
}

/** Ordered redactions removing each class of secret/PII before a snippet of
 * raw detail can be surfaced. */
function redactSecrets(text: string): string {
  return (
    text
      // Credentialed URLs: keep the scheme + host, drop the user:pass segment.
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/:@]+@/gi,
        `$1${REDACTED}@`,
      )
      // Bearer tokens.
      .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, `Bearer ${REDACTED}`)
      // Known provider key / token prefixes (sk-ant before sk- so the longer
      // Anthropic prefix wins).
      .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/gi, REDACTED)
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/gi, REDACTED)
      .replace(/\bglpat-[A-Za-z0-9_-]{8,}/gi, REDACTED)
      .replace(/\bgh[posur]_[A-Za-z0-9]{16,}/gi, REDACTED)
      .replace(/\bGOCSPX-[A-Za-z0-9_-]{8,}/gi, REDACTED)
      // Email addresses.
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED)
      // Long hex runs (hashes) and base64 / token-ish runs.
      .replace(/[A-Fa-f0-9]{32,}/g, REDACTED)
      .replace(/[A-Za-z0-9_-]{40,}/g, REDACTED)
  );
}

/** Turn any raw `detail` into a snippet safe to show a user: strip stack
 * frames, redact secrets/PII, collapse whitespace to single spaces, and cap
 * the length. Empty or whitespace-only detail yields an empty string. */
export function sanitizeDetail(detail: string): string {
  if (!detail || !detail.trim()) return "";
  const redacted = redactSecrets(stripStackFrames(detail));
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > SNIPPET_MAX_LENGTH
    ? collapsed.slice(0, SNIPPET_MAX_LENGTH).trimEnd()
    : collapsed;
}

/** Derive the user-facing failure message for a block error when the caller
 * did not supply an explicit safe message. Provider failures try the curated
 * causes first; otherwise (and for every other category) a sanitized snippet
 * of `detail` is appended to the generic per-category text so the message
 * explains *why* without leaking secrets. */
export function deriveFailureMessage(params: {
  category: ExecutionErrorCategory;
  detail: string;
  genericMessage: string;
}): string {
  const { category, detail, genericMessage } = params;
  if (category === "provider") {
    const curated = classifyProviderFailure(detail);
    if (curated) return curated;
  }
  const snippet = sanitizeDetail(detail);
  return snippet ? `${genericMessage} (${snippet})` : genericMessage;
}
