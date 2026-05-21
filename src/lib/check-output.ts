import type { Finding, Severity } from "./checks/types.js";
import { severityAtLeast } from "./checks/result.js";
import type {
  CheckRunAnnotation,
  ReviewCommentInput,
  ExistingReviewComment,
} from "../adapters/vcs/types.js";

export interface OutputCaps {
  max_check_annotations: number;
  max_review_comments: number;
  max_suggestions: number;
}

export interface CommentPolicy {
  enabled: boolean;
  severity_threshold: Severity;
  suggestions: boolean;
  suggestions_threshold: Severity;
}

const FINDING_MARKER_PREFIX = "<!-- ai-workflow:finding:";
const FINDING_MARKER_SUFFIX = " -->";

/**
 * GitHub rejects PR review/issue comment bodies above ~65k chars. Truncate any
 * single produced body to this limit with a clearly-marked notice.
 */
export const MAX_COMMENT_BODY = 65_000;
const TRUNCATION_NOTICE = "\n\n…truncated (comment exceeded GitHub's 65k limit)";

export function formatFindingMarker(fingerprint: string): string {
  return `${FINDING_MARKER_PREFIX}${fingerprint}${FINDING_MARKER_SUFFIX}`;
}

/**
 * Neutralize triple-backtick fences inside untrusted text so they cannot escape
 * the outer ``` ```suggestion ``` ``` fence we wrap them in. Inserts a
 * zero-width joiner between the backticks; renders identically and preserves
 * round-trippability through markdown parsers.
 */
function sanitizeFences(text: string): string {
  return text.replace(/`{3,}/g, (match) => match.split("").join("‍"));
}

/** Truncate a comment body to MAX_COMMENT_BODY, appending a visible notice. */
export function truncateCommentBody(
  body: string,
  max: number = MAX_COMMENT_BODY,
): string {
  if (body.length <= max) return body;
  const sliceLen = Math.max(0, max - TRUNCATION_NOTICE.length);
  return body.slice(0, sliceLen) + TRUNCATION_NOTICE;
}

/**
 * Convert findings to Check Run annotations.
 * - severity mapping: info → notice, warning → warning, critical → failure
 * - findings without primary_location are NOT annotations — caller must render them in summary/text.
 * - cap: at most caps.max_check_annotations; overflow message goes into `overflow_text`.
 */
export interface AnnotationsResult {
  annotations: CheckRunAnnotation[];
  /** Markdown describing dropped annotations; empty when none dropped. */
  overflow_text: string;
  /** Findings that could not be annotated (no primary_location). Caller renders in summary. */
  unanchored: Finding[];
}

export function findingsToAnnotations(
  findings: readonly Finding[],
  caps: OutputCaps,
): AnnotationsResult {
  const annotations: CheckRunAnnotation[] = [];
  const unanchored: Finding[] = [];
  const overflow: Finding[] = [];
  for (const f of findings) {
    if (!f.primary_location) {
      unanchored.push(f);
      continue;
    }
    if (annotations.length >= caps.max_check_annotations) {
      overflow.push(f);
      continue;
    }
    annotations.push({
      path: f.primary_location.path,
      start_line: f.primary_location.start_line,
      end_line: f.primary_location.end_line ?? f.primary_location.start_line,
      annotation_level:
        f.severity === "critical" ? "failure" : f.severity === "warning" ? "warning" : "notice",
      message: f.message,
      title: undefined,
      raw_details: undefined,
    });
  }
  const overflow_text_raw =
    overflow.length === 0
      ? ""
      : `\n\n**${overflow.length} additional finding(s) dropped due to annotation cap.**\n` +
        overflow
          .slice(0, 50)
          .map((f) => `- [${f.severity}] ${f.primary_location!.path}:${f.primary_location!.start_line} — ${f.message}`)
          .join("\n");
  // overflow_text is appended into a comment body by callers; keep it bounded.
  const overflow_text = truncateCommentBody(overflow_text_raw);
  return { annotations, overflow_text, unanchored };
}

/**
 * Convert findings to PR review comments respecting the policy and existing-marker dedupe.
 * Returns separate buckets for plain comments and suggestions (each capped).
 *
 * Suggestion validity rules:
 * - require suggestion present
 * - suggestion path must equal primary_location.path
 * - suggestion start_line/end_line must equal primary_location range
 * - suggestion must anchor to a changed diff line (caller provides changed line map per path)
 */
export interface CommentsResult {
  /** Plain (non-suggestion) review comments to post. */
  comments: ReviewCommentInput[];
  /** Suggestion comments to post (kept separate so the caller can apply max_suggestions). */
  suggestions: ReviewCommentInput[];
  /** Hidden markers found on existing comments — deduped against new ones. */
  skipped_duplicates: number;
  /** Comments dropped due to cap, severity below threshold, etc. (for notice). */
  dropped_by_cap: number;
  /** Findings that intended a suggestion but couldn't anchor cleanly — caller may promote to plain comment. */
  invalid_suggestions: Finding[];
}

export function findingsToComments(input: {
  findings: readonly Finding[];
  policy: CommentPolicy;
  caps: OutputCaps;
  existingComments: readonly ExistingReviewComment[];
  /** For each path, the changed-line ranges on the head SHA (from PRFile.changed_line_ranges). */
  changedLines: Record<string, ReadonlyArray<{ start: number; end: number }>>;
}): CommentsResult {
  if (!input.policy.enabled) {
    return {
      comments: [],
      suggestions: [],
      skipped_duplicates: 0,
      dropped_by_cap: 0,
      invalid_suggestions: [],
    };
  }

  const existingMarkers = new Set<string>();
  for (const c of input.existingComments) {
    const re = /<!-- ai-workflow:finding:([^ ]+) -->/g;
    for (const m of c.body.matchAll(re)) {
      existingMarkers.add(m[1]);
    }
  }

  const comments: ReviewCommentInput[] = [];
  const suggestions: ReviewCommentInput[] = [];
  const invalidSuggestions: Finding[] = [];
  let skippedDup = 0;
  let droppedByCap = 0;

  for (const f of input.findings) {
    if (!severityAtLeast(f.severity, input.policy.severity_threshold)) continue;
    if (!f.primary_location) continue;
    if (existingMarkers.has(f.fingerprint)) {
      skippedDup++;
      continue;
    }

    const marker = formatFindingMarker(f.fingerprint);

    // Try suggestion first when applicable.
    const wantSuggestion =
      input.policy.suggestions &&
      severityAtLeast(f.severity, input.policy.suggestions_threshold) &&
      f.suggestion;

    if (wantSuggestion && f.suggestion) {
      const valid = suggestionIsAnchored(f, input.changedLines);
      if (valid) {
        if (suggestions.length >= input.caps.max_suggestions) {
          droppedByCap++;
        } else {
          // Sanitize both message and replacement so a literal triple-backtick
          // in either can't break out of the outer ```suggestion fence.
          const safeMessage = sanitizeFences(f.message);
          const safeReplacement = sanitizeFences(f.suggestion.replacement);
          const body = truncateCommentBody(
            `${safeMessage}\n\n` +
              "```suggestion\n" +
              safeReplacement +
              "\n```\n\n" +
              marker,
          );
          suggestions.push({
            path: f.suggestion.path,
            line: f.suggestion.end_line,
            side: "RIGHT",
            body,
          });
        }
        continue;
      } else {
        invalidSuggestions.push(f);
      }
    }

    // Plain comment.
    if (comments.length >= input.caps.max_review_comments) {
      droppedByCap++;
      continue;
    }
    const relatedBlock = formatRelatedLocations(f);
    const safeMessage = sanitizeFences(f.message);
    const body = truncateCommentBody(`${safeMessage}${relatedBlock}\n\n${marker}`);
    comments.push({
      path: f.primary_location.path,
      line: f.primary_location.end_line ?? f.primary_location.start_line,
      side: "RIGHT",
      body,
    });
  }

  return {
    comments,
    suggestions,
    skipped_duplicates: skippedDup,
    dropped_by_cap: droppedByCap,
    invalid_suggestions: invalidSuggestions,
  };
}

function suggestionIsAnchored(
  f: Finding,
  changedLines: Record<string, ReadonlyArray<{ start: number; end: number }>>,
): boolean {
  if (!f.suggestion || !f.primary_location) return false;
  if (f.suggestion.path !== f.primary_location.path) return false;
  if (f.suggestion.start_line !== f.primary_location.start_line) return false;
  if (f.suggestion.end_line !== (f.primary_location.end_line ?? f.primary_location.start_line)) return false;
  const ranges = changedLines[f.suggestion.path];
  if (!ranges) return false;
  for (const r of ranges) {
    if (f.suggestion.start_line >= r.start && f.suggestion.end_line <= r.end) return true;
  }
  return false;
}

function formatRelatedLocations(f: Finding): string {
  if (!f.related_locations || f.related_locations.length === 0) return "";
  const lines = f.related_locations.map(
    (r) => `- ${r.path}${r.start_line ? `:${r.start_line}` : ""}${r.note ? ` — ${r.note}` : ""}`,
  );
  return `\n\n_Related:_\n${lines.join("\n")}`;
}
