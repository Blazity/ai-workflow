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

function renderRound(roundNumber: number, decision: HumanDecision): string {
  const meta: string[] = [];
  if (decision.answeredBy) meta.push(`answered by ${decision.answeredBy}`);
  if (decision.answeredAt) meta.push(decision.answeredAt);
  const heading = meta.length > 0
    ? `### Round ${roundNumber} (${meta.join(", ")})`
    : `### Round ${roundNumber}`;

  const lines = [heading];
  for (let i = 0; i < decision.questions.length; i++) {
    lines.push(`${i + 1}. ${decision.questions[i]}`);
  }
  lines.push("");
  // Keep the answer verbatim, including any embedded newlines.
  lines.push(`Answer: ${decision.answer}`);
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
 * - existing file WITH markers: replace the marked block in place (idempotent),
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
  if (existing.includes(START_MARKER)) {
    return existing.replace(SECTION_REGEX, section);
  }
  return `${existing.replace(/\s+$/, "")}\n\n${section}\n`;
}
