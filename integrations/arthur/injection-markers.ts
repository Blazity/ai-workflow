/**
 * Deterministic, high-precision pre-filter for blatant prompt-injection markers.
 *
 * This is a *floor*, not a replacement for the Arthur Engine. It matches only a
 * short list of unambiguous override phrases so an identical definitive payload
 * always produces an identical "flagged" verdict, independent of Arthur's
 * probabilistic classifier (whose model temperature and rule config live
 * server-side and are not controllable from this codebase).
 *
 * Tradeoff: content that legitimately *quotes* these phrases (for example a
 * ticket that is itself about prompt injection) will be flagged. That is an
 * accepted false-positive cost for a fail-closed security gate; the finding's
 * `rule` and `details` let an operator tell a real payload from a quote. The
 * marker list is intentionally narrow to keep that cost low.
 */

export interface BlatantInjectionFinding {
  rule: string;
  result: string;
  details: string;
}

/** Max characters kept from the matched snippet in a finding's details. */
const MARKER_SNIPPET_MAX_CHARS = 120;

const MARKERS: Array<{ rule: string; pattern: RegExp }> = [
  {
    // "ignore/disregard/forget/override (all) (the) previous/prior/above/system … instructions/prompt/rules"
    rule: "override_prior_instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,40}?\b(?:all\s+)?(?:the\s+)?(?:previous|prior|preceding|above|earlier|initial|original|system)\b[\s\S]{0,24}?\b(?:instructions?|prompts?|messages?|rules?|directions?|guidelines?|context)\b/i,
  },
  {
    // "reveal/print/repeat/output your system prompt / the instructions above"
    rule: "exfiltrate_system_prompt",
    pattern:
      /\b(?:reveal|show|print|repeat|output|display|disclose|dump)\b[\s\S]{0,40}?\b(?:your\s+)?(?:system\s+prompt|initial\s+instructions?|the\s+(?:instructions?|words|text|prompt)\s+above)\b/i,
  },
];

/**
 * Return one finding per matched blatant-injection marker (deduplicated by
 * rule), or an empty array when the content contains none. Pure and
 * deterministic: the same input always yields the same findings.
 */
export function detectBlatantInjection(content: string): BlatantInjectionFinding[] {
  const findings: BlatantInjectionFinding[] = [];
  for (const marker of MARKERS) {
    const match = marker.pattern.exec(content);
    if (match) {
      findings.push({
        rule: marker.rule,
        result: "Fail",
        details: match[0].replace(/\s+/g, " ").trim().slice(0, MARKER_SNIPPET_MAX_CHARS),
      });
    }
  }
  return findings;
}
