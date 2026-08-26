import { EXECUTION_DIAGNOSTIC_PREFIX } from "@shared/contracts";

import type { ExecutionErrorCategory } from "./interpreter.js";

/** Longest single-line snippet of raw `detail` we append to a user-facing
 * failure message. Keeps Slack messages and Jira comments compact. Sized so the
 * tail share below still fits a whole git/HTTP verdict line ("fatal: unable to
 * access '<url>': The requested URL returned error: 403" is 110 characters on
 * its own); at the previous 120 the tail clipped the verdict itself. */
const SNIPPET_MAX_LENGTH = 160;

/** Longest whole failure message allowed to cross a response boundary. A
 * composed message is already `lead (snippet) Diagnostic ID: ...`, so it is
 * legitimately longer than a bare snippet: bounding it at SNIPPET_MAX_LENGTH
 * would cut the snippet a second time and throw away the very cause the snippet
 * was sized to preserve.
 *
 * Sized so `deriveFailureMessage` can never produce a message this boundary has
 * to clamp. That matters beyond aesthetics: the run header runs the composed
 * message through this bound while Slack and the ticket comment receive it
 * unclamped, so any message longer than this makes the surfaces disagree, which
 * is the cross-surface guarantee AIW-254 has to hold. The worst legitimate
 * message is a hand-authored operator sentence (the longest in the tree is
 * ~250 characters, leak_review's) plus a 162-character wrapped snippet plus the
 * diagnostic suffix reserved below. */
const MESSAGE_MAX_LENGTH = 600;

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

/** Longest string we will accept as a diagnostic ID. The execution branch below
 * repeats its segment group, so without an overall cap a chunked payload of any
 * length satisfies the shape. Real IDs are ~59 characters. */
const DIAGNOSTIC_ID_MAX_LENGTH = 120;

/** Longest run of token characters allowed in one segment of an execution
 * diagnostic ID.
 *
 * This has ONE character of margin on real data: the production run-id segment
 * `wrun_01KYSFRC85YWWMD6WH2FQG0C30` is 31. Any change to the run-id scheme that
 * pushes it past 32 silently drops the correlation handle product-wide, because
 * the redaction below would eat the ID and every surface would show
 * `[redacted]` where the ID belongs. If run ids get longer, raise this with
 * them. */
const DIAGNOSTIC_ID_SEGMENT_MAX = 32;

/** Room `formatExecutionErrorForUser` needs for the trailing
 * " Diagnostic ID: <id>" it appends after derivation. Reserved out of
 * MESSAGE_MAX_LENGTH so the composed whole still fits the response boundary and
 * no surface has to clamp it. */
const DIAGNOSTIC_SUFFIX_RESERVE =
  " Diagnostic ID: ".length + DIAGNOSTIC_ID_MAX_LENGTH;

/** Longest message `deriveFailureMessage` may return, so the composed
 * message-plus-diagnostic-ID crosses every boundary unclamped. */
const DERIVED_MESSAGE_MAX_LENGTH = MESSAGE_MAX_LENGTH - DIAGNOSTIC_SUFFIX_RESERVE;

/** A whole, well-formed diagnostic ID. Deliberately anchored and shaped rather
 * than a prefix test: a bare `startsWith` check exempts anything merely
 * BEGINNING with the prefix, so a credential glued behind it rides straight out
 * to Slack and the dashboard.
 *
 * Two producers exist and both are covered, because a predicate that silently
 * rejects one whole family is a trap for the next caller:
 *  - `createWorkflowExecutionErrorState`: prefix + run id + node id + attempt,
 *    joined by "-". Segments are length-bounded, which is what stops a long
 *    opaque token from passing as a run or node id.
 *  - `recordIngestionFailure`: prefix + "ingest-" + a v4 UUID. Matched as a
 *    strict lowercase-hex UUID, so it cannot carry a base64 secret either.
 *
 * KNOWN AND ACCEPTED WEAKNESS, recorded deliberately rather than left implicit.
 * This is shape matching, not authentication, so it is defeatable by chunking a
 * known secret across segments that each satisfy the cap
 * (`AIW-DIAG-<32 chars>-<25 chars>-0`). Exploiting it needs BOTH text injection
 * into a failure detail AND prior knowledge of the secret, at which point the
 * attacker already has the secret; the length cap above at least stops a bulk
 * payload. The real fix is to stop inspecting shape and splice in the ID we
 * already know out of band, which means threading the run's own diagnostic ID
 * from the run record down to this boundary. That is a signature change across
 * files this change does not own, so it is deferred, not dismissed.
 *
 * Related, same cause: a node id containing any character outside
 * [A-Za-z0-9_-] mangles the ID rather than preserving it ("review.gate" yields
 * "[redacted].gate-1"). Node ids are validated only as a non-empty trimmed
 * string, so that needs a hand-authored definition; all eight built-in ids are
 * safe. */
const DIAGNOSTIC_ID_PATTERN = new RegExp(
  `^${EXECUTION_DIAGNOSTIC_PREFIX}(?:` +
    "ingest-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}" +
    `|(?:[A-Za-z0-9_]{1,${DIAGNOSTIC_ID_SEGMENT_MAX}}-){2,}\\d{1,4}` +
    ")$",
);

/** Curated (pattern, message) rules for provider-category failures. The first
 * match wins, so order them from the most to the least specific cause. Each
 * message names the cause and the fix without echoing the raw provider
 * payload, so it is safe for Slack and client-visible Jira comments. */
const PROVIDER_CAUSES: Array<{
  pattern: RegExp;
  message: string;
  /**
   * False for a pattern that is only trustworthy against a `detail` we composed,
   * because the same words occur in ordinary local process output. AIW-254 began
   * feeding raw stdout/stderr tails through this table, and a pattern whose words
   * a shell emits turns a wrong sentence into the whole message, which is worse
   * than the generic line it replaced. Defaults to true.
   */
  tailSafe?: boolean;
}> = [
  {
    // `no credits remaining` is the phrasing the OpenAI API returns through the
    // Codex CLI, captured verbatim on the Arthur outage of 2026-08-12:
    // "stream disconnected before completion: You have no credits remaining.
    // Add credits to continue using the API at .../organization/billing/."
    // It is matched explicitly rather than relying on `billing` appearing in
    // that trailing URL: a provider that drops the link, or shortens it, would
    // otherwise fall back to an unclassified snippet for the single cause this
    // rule exists to name. Only phrasings observed in real captures are added
    // here; guessing at wordings produces rules that never fire and rules that
    // fire on the wrong failure.
    pattern:
      /credit balance|billing|no credits remaining|insufficient.*(credit|quota|funds)/i,
    message:
      "The AI provider rejected the request: the account credit or billing balance is too low.",
  },
  {
    // `spend limit` is the phrasing the OpenAI API returns through the Codex
    // CLI, captured verbatim on the Arthur outage of 2026-08-21 (run
    // wrun_01M0J7D367ZQW6Q487T467M0PV): "stream disconnected before completion:
    // Your project has reached its configured enforced spend limit. Update your
    // limit at https://platform.openai.com/settings/proj_.../limits." The bigram
    // is matched instead of the full sentence so a reworded prefix keeps firing,
    // and no shell emits these words, so the rule stays trustworthy against
    // captured tails. Order relative to the credits rule above is not
    // correctness-bearing: the two patterns do not overlap.
    pattern: /\bspend limit\b/i,
    message:
      "The AI provider rejected the request: the account has reached its configured spend limit. Raise or remove the spend limit in the provider's billing settings, then rerun.",
  },
  {
    pattern: /rate.?limit(?!er)|\b429\b|too many requests/i,
    message: "The AI provider rate-limited the request. Please retry shortly.",
  },
  {
    pattern: /\b401\b|unauthorized|authentication|invalid.*(api.?key|x-api-key)/i,
    message:
      "The AI provider rejected the credentials (authentication failed). Check the API key.",
  },
  {
    // Kept as its own rule so it can be excluded from tail matching. "permission
    // denied" is the most common line in a failed local command's stderr (chmod,
    // exec, a read-only mount), and matching it there reported an unwritable
    // wrapper script as rejected API credentials.
    pattern: /permission denied/i,
    message:
      "The AI provider rejected the credentials (authentication failed). Check the API key.",
    tailSafe: false,
  },
  {
    pattern: /model.*(not found|does not exist|access|not allowed)/i,
    message: "The requested AI model is unavailable or access is denied.",
  },
  {
    pattern: /\b529\b|overloaded/i,
    message: "The AI provider is overloaded. Please retry shortly.",
  },
  {
    // Codex prefixes provider refusals with this transport line ("stream
    // disconnected before completion: You have no credits remaining."), so this
    // must stay the LAST rule: classifyProviderFailure tries rules in table
    // order for each candidate, and a named cause after the prefix has to win.
    // On its own the line names a dropped connection and nothing more.
    pattern: /stream disconnected before completion/i,
    message:
      "The AI provider connection dropped before the response completed. Please retry shortly.",
  },
];

/** True when `value` is a whole, well-formed diagnostic ID.
 *
 * Exported so every boundary that lets one through checks the same shape. A
 * looser test in one place is a hole in all of them: a bare
 * `startsWith(EXECUTION_DIAGNOSTIC_PREFIX)` admits anything merely beginning
 * with the prefix, so a credential glued behind it rides straight out. */
export function isDiagnosticId(value: string): boolean {
  return (
    value.length <= DIAGNOSTIC_ID_MAX_LENGTH && DIAGNOSTIC_ID_PATTERN.test(value)
  );
}

/** Match `detail` against the curated provider causes, returning the safe
 * message for the first hit, or undefined when nothing matches.
 *
 * `fromCapturedTail` says the text is raw process output rather than a detail we
 * composed, which excludes the rules whose words a shell also emits. */
export function classifyProviderFailure(
  detail: string,
  fromCapturedTail = false,
): string | undefined {
  for (const { pattern, message, tailSafe } of PROVIDER_CAUSES) {
    if (fromCapturedTail && tailSafe === false) continue;
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
      // Credentialed URLs: keep the scheme + host, drop the user:pass segment
      // AND the "@" that introduced it.
      //
      // The "@" matters for cross-surface agreement, not for secrecy. This used
      // to leave `scheme://[redacted]@host`, which the run trace's replay
      // sanitizer still reads as a credentialed URL (any userinfo satisfies its
      // pattern) and replaces WHOLE, host included, with its own marker. Slack
      // and the ticket comment do not run that pass, so one failure read three
      // different ways on three surfaces, and the surface that mattered most lost
      // the host (AIW-254). Dropping the "@" here redacts strictly more, keeps
      // the host on every surface, and makes the later pass a no-op.
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/:@]+@/gi, "$1")
      // Bearer and Basic credentials. Basic needs its own rule: a base64
      // "user:pass" pair is usually well under the token-run length below.
      //
      // Length alone separates a credential from prose here. "Basic
      // authentication is not supported" is a real GitHub and GitLab HTTP
      // error, and an 8-or-more-characters rule ate the diagnosis on exactly
      // the git auth failures this file exists to preserve.
      //
      // 16 is measured, not guessed. Across 157 MB of real library code, error
      // strings and docs, the longest all-lowercase run following "bearer" is 7
      // characters and the longest following "basic" is 14 ("authentication",
      // "implementation"), so the floor clears the worst observed prose by 2
      // characters and no real value was missed.
      //
      // There is deliberately NO "must contain an uppercase letter or digit"
      // guard. A valid opaque bearer token can be all lowercase, and for a
      // base64 Basic value the composition assumption is only probabilistic
      // (a 16-character run is all-lowercase about one time in 1.8 million),
      // so such a guard trades a certain under-redaction for a prose risk the
      // length floor already covers. Both schemes therefore get the same rule
      // shape; only the value alphabets differ, base64url separators for Bearer
      // and base64 padding for Basic.
      //
      // The scheme word is matched with a character class rather than the /i
      // flag on purpose: /i would also fold any [A-Z] guard to lowercase, which
      // is how a composition check silently becomes a no-op.
      .replace(/\b[Bb]earer\s+[A-Za-z0-9._-]{16,}/g, `Bearer ${REDACTED}`)
      .replace(/\b[Bb]asic\s+[A-Za-z0-9+/=_-]{16,}/g, `Basic ${REDACTED}`)
      // JWTs, whole. The token-run rule below only reaches the signature, so a
      // short claim set would otherwise travel in clear as header.payload.
      .replace(
        /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g,
        REDACTED,
      )
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
      // ours, not a credential, and quoting it is the entire point. Only a whole
      // well-formed ID is spared; anything else, prefixed or not, is redacted.
      // Every credential shape we recognise is handled above this rule, so the
      // exemption can at most spare an unrecognised token that is also shaped
      // exactly like a diagnostic ID.
      // Goes through isDiagnosticId, not the bare pattern, so the length cap
      // applies here too: one predicate, one answer, everywhere.
      .replace(/[A-Za-z0-9_-]{40,}/g, (match) =>
        isDiagnosticId(match) ? match : REDACTED,
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
 * which repository and which operation failed.
 *
 * Exported for the provider surfaces that impose their own shorter limit on an
 * already-composed message: a head slice there re-creates this same defect one
 * layer down, and it also truncates the trailing diagnostic ID into something
 * that still looks valid but correlates with nothing. */
export function clampBothEnds(text: string, maxLength: number): string {
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
  return clampBothEnds(collapsed, maxLength);
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

/**
 * Everything besides `detail` that a failure captured about its own cause.
 *
 * All of it is untrusted provider/CLI output and goes through the same
 * redaction as a `detail` snippet before any of it reaches a user.
 */
export interface FailureEvidence {
  /**
   * The cause a caller isolated out of its own composed prose. Highest
   * priority: a call site that already knows which fragment of its message is
   * the reason beats anything derived from the composed whole. This is how a
   * cause that sits in the MIDDLE of a composed sentence survives clamping,
   * which no head/tail clamp of the composed string can guarantee.
   */
  cause?: string;
  /** Error text the provider itself emitted in its structured result (a Claude
   *  error envelope, a Codex `error`/`turn.failed` event). */
  providerError?: string;
  /** Tail of the process's captured stderr. */
  stderrTail?: string;
  /** Tail of the process's captured stdout. */
  stdoutTail?: string;
  exitCode?: number | null;
  /** Agent protocol failure kind, used to name candidate causes when nothing
   *  classifies and to decide whether `detail` outranks the captured tails. */
  failureKind?: string;
}

/**
 * Failure kinds whose `detail` states the SHAPE of the failure and nothing
 * about its cause ("The CLI exited with code 1."), so the process's own
 * captured output outranks it.
 *
 * Every other kind (`invalid_json`, `missing_result`, `protocol_mismatch`,
 * `schema_mismatch`) has a `detail` that names the protocol problem, which IS
 * the cause at that layer; for those, 2 KB of agent JSONL is noise and the
 * detail leads.
 */
const SHAPE_ONLY_FAILURE_KINDS = new Set([
  "cli_exit",
  "missing_exit_code",
  "install_failed",
  "setup_failed",
  "version_unreadable",
  "version_mismatch",
  "provider_error",
]);

/** Candidate causes named when a failure classified against nothing and left no
 * usable output either, so the message still points somewhere instead of
 * shrugging. Keyed by protocol failure kind; anything unlisted gets the
 * default. */
const CANDIDATE_CAUSES: Record<string, string> = {
  cli_exit:
    "exhausted provider credits, a revoked or expired API key, or a model this account cannot use",
  missing_exit_code:
    "the sandbox losing the process, or the phase being killed before it could report",
  install_failed: "a package registry outage, or blocked network egress",
  setup_failed:
    "missing or rejected provider credentials, or blocked network egress",
  provider_error:
    "exhausted provider credits, a revoked or expired API key, or a provider-side outage",
};

const DEFAULT_CANDIDATE_CAUSES =
  "exhausted provider credits, rejected credentials, or a provider-side outage";

/** Shortest normalized snippet segment that can prove the lead already states
 * it. Below this a segment is a stray word ("and", "code") whose presence in
 * the lead proves nothing. */
const MIN_COMPARABLE_SEGMENT = 4;

/** Strip a text to lowercase alphanumerics so two spellings of one cause
 * ("leak_review" vs "Leak review") compare equal. */
function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True when the lead sentence already states everything the snippet would add,
 * so appending it would print the cause twice.
 *
 * Whole-string containment is not enough: a call site that composes an operator
 * sentence AROUND the same described cause ("Leak review blocked publication
 * before the branch was pushed: <cause>. Remove the secret and rerun.") carries
 * that cause with different surrounding words, so the composed snippet is not a
 * substring of the lead even though every informative part of it is. Hence the
 * segment test, and hence EVERY segment has to be present: requiring only the
 * longest one would silently swallow a short appended reason ("Repository
 * instructions could not be loaded: ENOENT").
 */
function leadAlreadyStates(lead: string, snippet: string): boolean {
  const normalizedLead = normalizeForComparison(lead);
  const normalizedSnippet = normalizeForComparison(snippet);
  if (!normalizedSnippet) return true;
  if (normalizedLead.includes(normalizedSnippet)) return true;
  const segments = snippet
    .split(/[.:;]\s+/)
    .map(normalizeForComparison)
    .filter((segment) => segment.length >= MIN_COMPARABLE_SEGMENT);
  return (
    segments.length > 0 &&
    segments.every((segment) => normalizedLead.includes(segment))
  );
}

/**
 * The trailing whole lines of a captured tail, taken until the snippet bound is
 * covered.
 *
 * A tail is cut at a byte offset, so its FIRST line is an arbitrary mid-stream
 * fragment and `clampBothEnds` would spend 40% of the snippet budget preserving
 * it. A `detail`, by contrast, starts at a real sentence boundary, which is why
 * only tails come through here.
 */
function trailingLines(text: string, budget: number): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const picked: string[] = [];
  let length = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    picked.unshift(line);
    length += line.length + 1;
    if (length >= budget) break;
  }
  return picked.join(" ");
}

/** Candidate evidence texts in priority order: the caller's isolated cause, the
 * structured provider error, stderr, stdout, then `detail`. `detail` moves
 * ahead of the tails for the failure kinds whose detail is the cause. */
function orderedEvidence(
  evidence: FailureEvidence | undefined,
  detail: string,
): Array<{ text: string; isTail: boolean }> {
  const tails = [
    { text: evidence?.providerError, isTail: true },
    { text: evidence?.stderrTail, isTail: true },
    { text: evidence?.stdoutTail, isTail: true },
  ];
  const detailEntry = { text: detail, isTail: false };
  const detailLeads =
    evidence?.failureKind !== undefined &&
    !SHAPE_ONLY_FAILURE_KINDS.has(evidence.failureKind);
  const ordered = [
    { text: evidence?.cause, isTail: false },
    ...(detailLeads ? [detailEntry, ...tails] : [...tails, detailEntry]),
  ];
  return ordered.filter(
    (candidate): candidate is { text: string; isTail: boolean } =>
      typeof candidate.text === "string" && candidate.text.trim().length > 0,
  );
}

/** Read an agent protocol diagnostic as failure evidence. Structural parameter
 * so this module keeps its type-only dependency surface and stays importable
 * from workflow scope. */
export function failureEvidenceFromDiagnostic(diagnostic: {
  failureKind?: string;
  exitCode?: number | null;
  providerError?: string;
  stderrTail?: string;
  stdoutTail?: string;
}): FailureEvidence {
  return {
    ...(diagnostic.providerError !== undefined
      ? { providerError: diagnostic.providerError }
      : {}),
    ...(diagnostic.stderrTail !== undefined
      ? { stderrTail: diagnostic.stderrTail }
      : {}),
    ...(diagnostic.stdoutTail !== undefined
      ? { stdoutTail: diagnostic.stdoutTail }
      : {}),
    ...(diagnostic.exitCode !== undefined && diagnostic.exitCode !== null
      ? { exitCode: diagnostic.exitCode }
      : {}),
    ...(diagnostic.failureKind !== undefined
      ? { failureKind: diagnostic.failureKind }
      : {}),
  };
}

/** The last-resort clause: no rule matched and nothing usable was captured, so
 * name what this failure kind is usually caused by and say where the raw
 * session is. Never a bare shrug, which is the whole point of AIW-254. */
function unclassifiedClause(evidence: FailureEvidence | undefined): string {
  const exitCode = evidence?.exitCode;
  const opening =
    typeof exitCode === "number"
      ? `It exited with code ${exitCode} and captured no output explaining why.`
      : "No cause was captured with this failure.";
  const candidates =
    (evidence?.failureKind !== undefined
      ? CANDIDATE_CAUSES[evidence.failureKind]
      : undefined) ?? DEFAULT_CANDIDATE_CAUSES;
  return `${opening} Likely causes: ${candidates}. The raw session is in the failed attempt's LOGS tab.`;
}

/** Join a lead sentence and a trailing clause within the derived bound, giving
 * the clause the budget it needs first. Clamping the lead rather than the whole
 * is what makes the cause survive: the lead is boilerplate advice, the clause
 * is the reason. */
function composeWithinBound(lead: string, clause: string): string {
  const budget = DERIVED_MESSAGE_MAX_LENGTH - clause.length - 1;
  if (budget <= 0) return clampBothEnds(clause, DERIVED_MESSAGE_MAX_LENGTH);
  return `${clampBothEnds(lead, budget)} ${clause}`;
}

/**
 * Derive the user-facing failure message for a block error.
 *
 * Runs for EVERY failure, including the ones whose call site supplied its own
 * `explicitMessage`. Before AIW-254 an explicit message short-circuited this
 * function, and since every agent call site supplies one, an agent phase always
 * read "The current agent phase could not be completed." while the provider's
 * own one-line reason sat unread in the captured tails beside it. An explicit
 * message now sets the leading sentence and nothing more.
 *
 * Order of preference:
 *  1. A curated provider cause matched against ANY evidence, not just `detail`.
 *  2. The lead sentence plus a sanitized snippet of the strongest evidence.
 *  3. The lead sentence plus candidate causes and where the raw session lives.
 */
export function deriveFailureMessage(params: {
  category: ExecutionErrorCategory;
  detail: string;
  genericMessage: string;
  /** Safe sentence the call site authored. Sets the lead; never suppresses the
   *  cause. */
  explicitMessage?: string;
  evidence?: FailureEvidence;
}): string {
  const { category, detail, genericMessage, explicitMessage, evidence } = params;
  const lead = explicitMessage?.trim() || genericMessage;
  const candidates = orderedEvidence(evidence, detail);

  if (category === "provider") {
    for (const candidate of candidates) {
      const curated = classifyProviderFailure(candidate.text, candidate.isTail);
      // The curated text names the cause and the fix on its own, so it stands
      // as the whole message: prefixing the generic category line back onto it
      // would only restate that the block failed.
      if (curated) return curated;
    }
  }

  const normalizedGeneric = normalizeForComparison(genericMessage);
  const composed = ((): string => {
    for (const candidate of candidates) {
      const snippet = sanitizeDetail(
        candidate.isTail
          ? trailingLines(candidate.text, SNIPPET_MAX_LENGTH)
          : candidate.text,
      );
      if (!snippet) continue;
      // A snippet that is itself part of the generic per-category sentence IS
      // the boilerplate, so it can add nothing and must not be mistaken by the
      // duplicate guard below for "the lead already stated the cause". Skipping
      // it here is what sends such a failure to the candidate-cause clause
      // instead of back to the bare category line.
      if (normalizedGeneric.includes(normalizeForComparison(snippet))) continue;
      if (leadAlreadyStates(lead, snippet)) {
        return clampBothEnds(lead, DERIVED_MESSAGE_MAX_LENGTH);
      }
      return composeWithinBound(lead, `(${snippet})`);
    }
    return composeWithinBound(lead, unclassifiedClause(evidence));
  })();

  // The AIW-254 invariant, enforced here rather than trusted at ~90 call sites:
  // a message identical to the bare per-category sentence explains nothing, and
  // that is exactly what every failure surface rendered before this change. It
  // is reachable two ways: a `detail` that sanitizes to nothing, and a `detail`
  // whose text is already inside the generic sentence, which `leadAlreadyStates`
  // legitimately suppresses. Both fall back to naming candidate causes.
  if (normalizeForComparison(composed) === normalizedGeneric) {
    return composeWithinBound(lead, unclassifiedClause(evidence));
  }
  return composed;
}
