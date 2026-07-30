import { EXECUTION_DIAGNOSTIC_PREFIX } from "@shared/contracts";

import type { ExecutionErrorCategory } from "./interpreter.js";

/** Longest single-line snippet of raw `detail` we append to a user-facing
 * failure message. Keeps Slack messages and Jira comments compact. Sized so the
 * tail share below still fits a whole git/HTTP verdict line ("fatal: unable to
 * access '<url>': The requested URL returned error: 403" is 110 characters on
 * its own); at the previous 120 the tail clipped the verdict itself. */
const SNIPPET_MAX_LENGTH = 160;

/** Longest whole failure message allowed to cross a response boundary. A
 * composed message is already `generic (snippet) Diagnostic ID: ...`, so it is
 * legitimately longer than a bare snippet: bounding it at SNIPPET_MAX_LENGTH
 * would cut the snippet a second time and throw away the very cause the snippet
 * was sized to preserve. */
const MESSAGE_MAX_LENGTH = 400;

/** Longest single-line detail written to the correlated operator log record.
 * Matches the bound `logPhaseFailure` already uses for a logged reason, so one
 * failure costs one bounded log field rather than a stack dump. */
const OPERATOR_DETAIL_MAX_LENGTH = 1_000;

const REDACTED = "[redacted]";

/** Stands in for the elided middle of an over-long single line. ASCII only, so
 * it survives every log, Slack and Jira encoding unchanged. */
const ELISION = " [...] ";

/** Share of the surviving budget handed to the tail. Weighted towards the tail
 * because that is where diagnostics put the verdict. */
const TAIL_SHARE = 0.6;

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
    pattern: /rate.?limit(?!er)|\b429\b|too many requests/i,
    message: "The AI provider rate-limited the request. Please retry shortly.",
  },
  {
    pattern:
      /\b401\b|unauthorized|authentication|invalid.*(api.?key|x-api-key)|permission denied/i,
    message:
      "The AI provider rejected the credentials (authentication failed). Check the API key.",
  },
  {
    pattern: /model.*(not found|does not exist|access|not allowed)/i,
    message: "The requested AI model is unavailable or access is denied.",
  },
  {
    pattern: /\b529\b|overloaded/i,
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
      // A diagnostic ID ("AIW-DIAG-<runId>-<nodeId>-<attempt>") is itself a run
      // of 40+ token-ish characters, so this rule used to redact the one
      // identifier that correlates a message with its server log record. It is
      // ours, not a credential, and quoting it is the entire point.
      .replace(/[A-Za-z0-9_-]{40,}/g, (match) =>
        match.startsWith(EXECUTION_DIAGNOSTIC_PREFIX) ? match : REDACTED,
      )
  );
}

/** Cap `text` at `maxLength` while keeping BOTH ends, with `ELISION` standing
 * in for the elided middle.
 *
 * A plain head slice reliably destroys the cause. Diagnostics are written
 * verdict-last: git prints "Cloning into '<path>'..." first and
 * "fatal: unable to access '<url>': The requested URL returned error: 403"
 * last, so cutting from the front keeps the noise and drops the diagnosis every
 * single time. Keeping both ends is cause-agnostic (it does not depend on a
 * "fatal:" spelling only git uses) and still keeps the head, which carries
 * which repository and which operation failed. */
function clampSingleLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const budget = maxLength - ELISION.length;
  const tailLength = Math.ceil(budget * TAIL_SHARE);
  const head = text.slice(0, budget - tailLength).trimEnd();
  const tail = text.slice(text.length - tailLength).trimStart();
  return `${head}${ELISION}${tail}`;
}

/** Shared single-line pipeline behind every exported sanitizer here: strip
 * stack frames, redact secrets/PII, collapse whitespace to single spaces, then
 * cap. Redaction runs over the whole text BEFORE the cap, so no part that
 * survives the cap can carry a secret the cap happened to spare. Empty or
 * whitespace-only input yields an empty string. */
function sanitizeSingleLine(text: string, maxLength: number): string {
  if (!text || !text.trim()) return "";
  // Drop a leading generic JS error-class prefix ("Error:", "TypeError:", ...)
  // so the snippet leads with the actual cause, not the error class name.
  const withoutErrorClass = stripStackFrames(text).replace(
    /^\s*(?:[A-Za-z_$][\w$]*)?Error:\s*/,
    "",
  );
  const redacted = redactSecrets(withoutErrorClass);
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return clampSingleLine(collapsed, maxLength);
}

/** Turn any raw `detail` into a snippet safe to show a user. */
export function sanitizeDetail(detail: string): string {
  return sanitizeSingleLine(detail, SNIPPET_MAX_LENGTH);
}

/** Same guarantees as `sanitizeDetail`, for a whole already-composed failure
 * message on its way across a response boundary. Re-running the snippet cap
 * over such a message would truncate the composed text a second time and lose
 * the cause, so it gets the message-sized bound instead. */
export function sanitizeFailureMessage(message: string): string {
  return sanitizeSingleLine(message, MESSAGE_MAX_LENGTH);
}

/** The failure detail an operator gets, in the server log record correlated by
 * diagnostic ID. Identical redaction to the customer-facing snippet, a far
 * larger bound, and stack frames still stripped: frames are what turns a detail
 * into a firehose, they leak internal absolute paths, and for the failures this
 * record exists to explain (git, HTTP, provider) the cause is in the message
 * text, never in the frames. */
export function operatorFailureDetail(detail: string): string {
  return sanitizeSingleLine(detail, OPERATOR_DETAIL_MAX_LENGTH);
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
