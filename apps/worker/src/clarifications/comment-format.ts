/**
 * Pure text builders for the Jira comments that carry clarification questions
 * to a human. Kept free of env/adapter imports so both the workflow (posting)
 * and any later resume path (nudge / already-answered replies) can reuse them
 * and test them in isolation. The Jira adapter turns newlines into ADF
 * paragraphs, so these emit plain text with blank lines between sections.
 */

/**
 * Substring a later stage matches to recognize its own nudge comment and avoid
 * re-posting it. Must appear verbatim in the nudge body.
 */
export const CLARIFICATION_NUDGE_MARKER =
  "still waiting for answers to its clarification questions";

/** Format an ISO instant as a human-readable UTC minute, e.g. `2026-07-29 14:03 UTC`. */
function formatUtcMinute(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** The full questions comment posted when a run pauses for clarification. */
export function formatClarificationQuestionsComment(input: {
  questions: string[];
  suggestedAnswers: string[] | null;
  dashboardUrl: string;
  aiColumnName: string;
  expiresAtIso: string | null;
}): string {
  const sections: string[] = [
    "The AI workflow needs clarification before it can continue with this ticket:",
    input.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
  ];

  if (input.suggestedAnswers && input.suggestedAnswers.length > 0) {
    sections.push(
      ["Suggested answers:", ...input.suggestedAnswers.map((s) => `- ${s}`)].join("\n"),
    );
  }

  sections.push(
    [
      "How to answer:",
      `- In the dashboard: ${input.dashboardUrl}`,
      `- Or reply in a comment on this ticket and move it back to the "${input.aiColumnName}" column.`,
    ].join("\n"),
  );

  if (input.expiresAtIso) {
    sections.push(
      `The paused run is resumable until ${formatUtcMinute(input.expiresAtIso)}. After that the ticket starts over from scratch.`,
    );
  }

  return sections.join("\n\n");
}

/** Short reminder that a parked run is still waiting on answers. */
export function formatClarificationNudgeComment(input: {
  dashboardUrl: string;
  aiColumnName: string;
}): string {
  return [
    `The AI workflow is ${CLARIFICATION_NUDGE_MARKER} on this ticket.`,
    `Answer in the dashboard (${input.dashboardUrl}) or reply in a comment here and move the ticket back to the "${input.aiColumnName}" column.`,
  ].join("\n");
}

/** One-liner acknowledging that a clarification was answered and the run resumes. */
export function formatAlreadyAnsweredComment(input: { answeredByLabel: string }): string {
  return `This clarification was already answered by ${input.answeredByLabel}; the run is resuming.`;
}
