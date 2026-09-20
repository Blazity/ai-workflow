/**
 * What may not be stored in a briefing or an answer delivery: the capture
 * detector, the `VisibilitySanitizer` the worker injects into
 * `buildAgentBriefing` (`@shared/agent-visibility`).
 *
 * It reports POSITIONS in the text it was given and never rewrites it, so
 * everything outside a reported span is byte for byte what the model or the
 * person sent. Its duty is written on `VisibilitySanitizer`; in short:
 *
 * - Always: configured secrets (also JSON-escaped and URL-encoded), credential
 *   shapes (private keys, a header with no END line running to the end of the
 *   text; JWTs; the value after a bearer or basic Authorization header; the
 *   credential of a credential URL; sk-, gh*_, github_pat_, glpat-, xox*
 *   tokens), and every span MCP's serve-time sanitizer
 *   (`mcp/sanitize-result.ts`) would rewrite, so the stored text is a fixed
 *   point of it with no redaction counted, whole and in any page cut out of it.
 * - Personal data (emails, phone numbers, payment cards, IBANs) only while
 *   `BRIEFING_REDACTS_PERSONAL_DATA` says so.
 * - NOT the replay sanitizer's presentation heuristics (`cookie:` lines, `-u`
 *   arguments, user-only URLs, key-shaped fields): a prompt is text an agent
 *   was really sent, and those rules remove words that are no credential.
 *
 * CONTROL CHARACTERS ARE REMOVED, NOT THE TEXT AROUND THEM. Only the escape,
 * the bell and the rest of the C0 set go; the printable body of an ANSI
 * sequence stays, because deleting from an escape to its terminator swallows
 * whole sentences of a CI log between two hyperlinks. Nothing MCP rewrites
 * survives that: its ANSI rule needs the escape, which is gone.
 *
 * WHAT IT CANNOT SEE. A secret is found as text, so a value the sender broke
 * up is only found where a removal can put it back together: this detector
 * searches the text as it is, the text without its control characters, and the
 * text without whole ANSI sequences (a token with a colour code inside it), in
 * each case reporting the span in the ORIGINAL text. A secret wrapped across a
 * line break by a CI renderer, split by a comment, or re-encoded in a form
 * nobody listed (base64 of its bytes, say) is not found by any of them; the
 * forms that are covered are the raw value, a JSON string (and a JSON string
 * inside one), and URL encoding.
 */
import {
  applyRemovals,
  CONTROL_CHARACTERS_REDACTION_KIND,
  DEFAULT_REDACTION_REPLACEMENT,
  mergeRedactions,
  type AppliedSpan,
  type VisibilityRedaction,
  type VisibilityRemoval,
  type VisibilitySanitizer,
} from "@shared/agent-visibility";
import { configuredReplaySecrets } from "./configured-secrets.js";
import { JWT_PATTERN, PERSONAL_DATA_RULES } from "./sanitizer.js";

/**
 * Whether personal data (emails, phone numbers, payment cards, IBANs) is
 * removed from briefings and answer deliveries at capture.
 *
 * FALSE UNTIL THE OWNER DECIDES. The ticket text holding them is already in
 * Jira and was sent to the model; removing them makes a briefing a less exact
 * record of what the agent got, and the rules that find them are heuristics.
 * Credentials are removed either way.
 */
export const BRIEFING_REDACTS_PERSONAL_DATA = false;

/**
 * The detector could not prove that what it would leave behind is clean.
 *
 * Thrown rather than answered with a span over the whole text: a briefing
 * whose section reads `[REDACTED]` looks like a captured send nobody may see,
 * while what really happened is that capture refused. The caller records the
 * refusal and says so.
 */
export class VisibilityCaptureRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisibilityCaptureRefusal";
  }
}

export interface VisibilityDetectorOptions {
  /** Every configured secret value, as `configuredReplaySecrets` lists them. */
  secrets: readonly string[];
  /** Defaults to `BRIEFING_REDACTS_PERSONAL_DATA`. */
  personalData?: boolean;
}

// Exactly the control characters MCP strips (`mcp/sanitize-result.ts`), tab,
// line feed and carriage return apart.
// oxlint-disable-next-line no-control-regex -- the rule is about control characters
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// MCP's ANSI rule, used only to search a text as it would read without its
// escape sequences, never to delete one.
// oxlint-disable-next-line no-control-regex -- the rule is about control characters
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const ESCAPE = "\u001B";

interface CredentialRule {
  kind: string;
  pattern: RegExp;
  /** The capture group that is the credential; the whole match when absent.
   *  A pattern with a group carries the `d` flag. */
  group?: number;
}

/**
 * The credential shapes. The first three are MCP's own rules as it matches
 * them, so nothing they match can remain: MCP counts a redaction even where
 * its replacement equals what it replaced.
 */
const CREDENTIAL_RULES: readonly CredentialRule[] = [
  // To the END line, or to the end of the text: MCP reads the end of whatever
  // string it serves as the end of the block, and a page can end anywhere.
  { kind: "private_key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  // THE VALUE AND THE SPACE BEFORE IT, never the words: a sentence about
  // bearer tokens keeps its sentence. The space goes with the value because
  // MCP's rule is `Bearer\s+<value>`, so `Bearer [REDACTED]` would be rewritten
  // again on any page that cuts inside the marker, while `Bearer[REDACTED]`
  // matches nothing of its own.
  { kind: "token", pattern: /Authorization\s*:\s*Bearer(\s+[^\s"'\\]+)/dgi, group: 1 },
  // A GitHub token anywhere, not only at a word boundary and past 255
  // characters too: a page can start right before it or end inside it.
  { kind: "token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "token", pattern: /Authorization\s*:\s*Basic(\s+[A-Za-z0-9+/=._~-]+)/dgi, group: 1 },
  { kind: "credential_url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+:[^\s/@]+)@/dgi, group: 1 },
  { kind: "jwt", pattern: JWT_PATTERN },
  { kind: "token", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: "token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}/g },
  { kind: "token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
];

/** Every form a configured secret takes in text a prompt carries: as it is,
 *  inside a JSON string (and a JSON string inside one), and URL-encoded. */
function secretForms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const nestedJson = JSON.stringify(json).slice(1, -1);
  const url = encodeURIComponent(secret);
  const forms = [
    secret,
    json,
    nestedJson,
    url,
    url.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    url.replace(/%20/g, "+"),
  ];
  return [...new Set(forms)];
}

/** Lone surrogates as U+FFFD, as MCP's UTF-8 round trip and the package write
 *  them. */
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** Where the detector says it is, for the package's own refusals. */
const WHERE = "the capture detector";

/**
 * A text with some spans removed, and the way back to the text it came from.
 *
 * Merged and applied by the package (`mergeRedactions`, `applyRemovals`), so
 * what is searched below is exactly what a briefing will store rather than a
 * second implementation of the same walk.
 */
interface Applied {
  text: string;
  removals: readonly VisibilityRemoval[];
  spans: readonly AppliedSpan[];
  originLength: number;
}

function applied(text: string, reports: readonly VisibilityRedaction[]): Applied {
  const removals = mergeRedactions(text, reports, WHERE);
  const written = applyRemovals(text, removals);
  return { text: written.text, removals, spans: written.spans, originLength: text.length };
}

/** Where `[start, end)` of an applied text came from: a replacement stands for
 *  everything it replaced. */
function origin(from: Applied, start: number, end: number): { start: number; end: number } {
  // The applied text is kept stretches and replacements in order: replacement
  // `k` is `spans[k]` and stands for `removals[k]`, and the stretch before it
  // ends where that removal starts.
  const at = (index: number) => {
    let low = 0;
    let high = from.spans.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (from.spans[middle]!.end16 > index) high = middle;
      else low = middle + 1;
    }
    const span = from.spans[low];
    const removal = from.removals[low];
    if (!span || !removal) {
      // The tail after the last replacement, kept as it was.
      const offset = from.originLength - (from.text.length - index);
      return { start: offset, end: offset + 1 };
    }
    if (span.start16 <= index) return { start: removal.start, end: removal.end };
    const offset = removal.start - (span.start16 - index);
    return { start: offset, end: offset + 1 };
  };
  return { start: at(start).start, end: at(Math.max(end - 1, start)).end };
}

/** The attempts to reach a fixed point before the whole text is refused. */
const FIXED_POINT_ROUNDS = 8;

export function createVisibilityDetector(options: VisibilityDetectorOptions): VisibilitySanitizer {
  const personalData = options.personalData ?? BRIEFING_REDACTS_PERSONAL_DATA;
  // A secret inside the marker itself could never be removed from a marker;
  // MCP would rewrite every marker in any text, so no text could satisfy it.
  const secretTexts = [
    ...new Set(
      options.secrets
        .filter((secret) => secret.length > 0 && !DEFAULT_REDACTION_REPLACEMENT.includes(secret))
        .flatMap(secretForms),
    ),
  ];

  /** Every credential, secret and (when on) personal data span in `text`. */
  const findIn = (text: string): VisibilityRedaction[] => {
    const found: VisibilityRedaction[] = [];
    for (const rule of CREDENTIAL_RULES) {
      for (const match of text.matchAll(rule.pattern)) {
        if (rule.group === undefined) {
          if (match[0].length > 0) found.push({ start: match.index, end: match.index + match[0].length, kind: rule.kind });
          continue;
        }
        const range = match.indices?.[rule.group];
        if (range) found.push({ start: range[0], end: range[1], kind: rule.kind });
      }
    }
    for (const secret of secretTexts) {
      for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + secret.length)) {
        found.push({ start: at, end: at + secret.length, kind: "configured_secret" });
      }
    }
    if (personalData) {
      for (const rule of PERSONAL_DATA_RULES) {
        for (const match of text.matchAll(rule.pattern)) {
          if (rule.accept && !rule.accept(match[0])) continue;
          found.push({ start: match.index, end: match.index + match[0].length, kind: rule.kind });
        }
      }
    }
    return found;
  };

  /** What `findIn` sees in a text some spans were taken out of, reported where
   *  it really is in the text they were taken out of. */
  const findThrough = (from: Applied): VisibilityRedaction[] =>
    findIn(from.text).map((span) => {
      const at = origin(from, span.start, span.end);
      return { start: at.start, end: at.end, kind: span.kind };
    });

  /**
   * One pass: the control characters, then the credentials and secrets in the
   * text without them, and in the text without whole escape sequences, so a
   * value a colour code cuts in half is still reported (as one span over the
   * sequence, which is what removes it).
   */
  const detectOnce = (text: string): VisibilityRedaction[] => {
    const control: VisibilityRedaction[] = [...text.matchAll(CONTROL_CHARACTER)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      kind: CONTROL_CHARACTERS_REDACTION_KIND,
      replacement: "",
    }));
    if (control.length === 0) return findIn(text);
    const found: VisibilityRedaction[] = [...control, ...findThrough(applied(text, control))];
    if (text.includes(ESCAPE)) {
      const sequences: VisibilityRedaction[] = [...text.matchAll(ANSI_SEQUENCE)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        kind: CONTROL_CHARACTERS_REDACTION_KIND,
        replacement: "",
      }));
      // Whatever this view finds is reported as a credential over the original
      // range, sequence included: the marker says a value was there, where
      // deleting the sequence alone would leave its halves readable. Most of
      // it is what the first view already found, so the same span is reported
      // once.
      const seen = new Set(found.map((span) => `${span.start}:${span.end}:${span.kind}`));
      for (const span of findThrough(applied(text, [...sequences, ...control]))) {
        if (seen.has(`${span.start}:${span.end}:${span.kind}`)) continue;
        found.push(span);
      }
    }
    return found;
  };

  return (given: string): VisibilityRedaction[] => {
    const text = wellFormed(given);
    const reports = detectOnce(text);
    // THE FIXED POINT, BY CONSTRUCTION RATHER THAN BY ARGUMENT. What the
    // package will store is computed here and searched again; anything a
    // removal exposed (a URL whose user was a secret, a shape joined across a
    // marker) is traced back to the original text and removed too.
    for (let round = 0; round < FIXED_POINT_ROUNDS; round += 1) {
      const stored = applied(text, reports);
      const left = detectOnce(stored.text);
      if (left.length === 0) return reports;
      const coveredBefore = stored.removals.reduce((total, removal) => total + removal.end - removal.start, 0);
      for (const span of left) {
        const at = origin(stored, span.start, span.end);
        reports.push({ start: at.start, end: at.end, kind: span.kind });
      }
      const coveredAfter = mergeRedactions(text, reports, WHERE).reduce(
        (total, removal) => total + removal.end - removal.start,
        0,
      );
      if (coveredAfter === coveredBefore) break;
    }
    throw new VisibilityCaptureRefusal(
      `after ${FIXED_POINT_ROUNDS} rounds the capture detector still found a credential in what it would store of a text of ${text.length} characters, so it stored none of it`,
    );
  };
}

/** The detector over this deployment's configured secrets. */
export function configuredVisibilityDetector(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): VisibilitySanitizer {
  return createVisibilityDetector({ secrets: configuredReplaySecrets(environment) });
}

/**
 * `text` as it may be stored: its reports applied the way the package applies
 * them to a briefing. For the free text kept outside a briefing (an answer
 * delivery's words, note, author and reading), which the package's rounds
 * assembler shows as it finds it.
 *
 * Throws `VisibilityCaptureRefusal` where the detector cannot prove what would
 * be left is clean; the caller decides what a field nobody may see becomes.
 */
export function redactForStorage(text: string, detect: VisibilitySanitizer): string {
  const wellFormedText = wellFormed(text);
  return applyRemovals(wellFormedText, mergeRedactions(wellFormedText, detect(wellFormedText), WHERE)).text;
}
