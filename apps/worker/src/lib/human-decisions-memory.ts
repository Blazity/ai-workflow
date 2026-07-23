// Pure helpers for the deterministic "Human decisions" memory section. No node,
// env, or pino imports here so this module is safe to pull into workflow scope.

const START_MARKER = "<!-- human-decisions:start -->";
const END_MARKER = "<!-- human-decisions:end -->";
const SECTION_REGEX = /<!-- human-decisions:start -->[\s\S]*?<!-- human-decisions:end -->/;

export type HumanDecision = {
  questions: string[];
  answer: string;
  answeredBy?: string;
  answeredAt?: string;
};

// User text must never be able to terminate the section: a literal marker
// inside a question or answer would make the next upsert's regex stop early
// and orphan the rest of the block. Defang by dropping the comment delimiters.
function defangMarkers(text: string): string {
  return text
    .split(START_MARKER)
    .join("[human-decisions:start]")
    .split(END_MARKER)
    .join("[human-decisions:end]");
}

function renderRound(roundNumber: number, decision: HumanDecision): string {
  const meta: string[] = [];
  if (decision.answeredBy) meta.push(`answered by ${defangMarkers(decision.answeredBy)}`);
  if (decision.answeredAt) meta.push(decision.answeredAt);
  const heading = meta.length > 0
    ? `### Round ${roundNumber} (${meta.join(", ")})`
    : `### Round ${roundNumber}`;

  const lines = [heading];
  for (let i = 0; i < decision.questions.length; i++) {
    lines.push(`${i + 1}. ${defangMarkers(decision.questions[i]!)}`);
  }
  lines.push("");
  // Keep the answer verbatim (embedded newlines included), markers excepted.
  lines.push(`Answer: ${defangMarkers(decision.answer)}`);
  return lines.join("\n");
}

/**
 * Renders the marker-delimited "Human decisions" block from the clarification
 * Q&A. Rounds appear in chronological order; the "answered by" and timestamp
 * parenthetical parts are omitted individually when absent; answers are kept
 * verbatim.
 */
export function renderHumanDecisionsSection(clarifications: HumanDecision[]): string {
  const rounds = clarifications
    .map((decision, index) => renderRound(index + 1, decision))
    .join("\n\n");

  return [
    START_MARKER,
    "## Human decisions (from the dashboard)",
    "",
    "Recorded automatically from the clarification Q&A. Do not edit or remove.",
    "",
    rounds,
    END_MARKER,
  ].join("\n");
}

/**
 * Upserts the rendered section into the memory file contents:
 * - existing file WITH a complete marker pair: replace the block in place
 *   (idempotent),
 * - existing file with a LONE start marker (end marker lost): rewrite from the
 *   marker to the end of file with the fresh complete block, so the current
 *   Q&A is never silently dropped,
 * - existing file WITHOUT markers: append the block after a blank line,
 * - no existing file (null): create a minimal header plus the block.
 */
export function upsertHumanDecisionsSection(
  existing: string | null,
  section: string,
  taskId: string,
): string {
  if (existing === null) {
    return `# Session Memory: ${taskId}\n\n${section}\n`;
  }
  if (SECTION_REGEX.test(existing)) {
    // Replacer function, not a string: a "$&"-style sequence in the Q&A must
    // land verbatim instead of being expanded as a replacement pattern.
    return existing.replace(SECTION_REGEX, () => section);
  }
  if (existing.includes(START_MARKER)) {
    const prefix = existing.slice(0, existing.indexOf(START_MARKER)).replace(/\s+$/, "");
    return prefix ? `${prefix}\n\n${section}\n` : `${section}\n`;
  }
  return `${existing.replace(/\s+$/, "")}\n\n${section}\n`;
}
