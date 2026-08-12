import { scrubForPublication } from "../lib/publication-scrub.js";

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

/**
 * The full questions comment posted when a run pauses for clarification.
 *
 * `questions` and `suggestedAnswers` are the only agent-authored strings here:
 * they arrive from the research/implementation phase's structured output, or
 * from a human_question block's params, and are published verbatim into the
 * customer's ticket. Both go through scrubForPublication, the same output-side
 * control the PR body and the ticket-comment block use, because the agent has
 * been observed reporting its platform bookkeeping in prose it was asked to
 * write for a customer.
 *
 * Everything else in the comment is ours: the section labels, the numbering, the
 * dashboard URL, the configured column name and the expiry sentence. They are
 * correct by construction, so scrubbing them could only corrupt them. The scrub
 * is per field rather than over the composed comment for the same reason, and
 * because removing a whole numbered item would silently renumber the list a
 * human is about to answer.
 */
export function formatClarificationQuestionsComment(input: {
  questions: string[];
  suggestedAnswers: string[] | null;
  dashboardUrl: string;
  aiColumnName: string;
  expiresAtIso: string | null;
}): string {
  const sections: string[] = [
    "The AI workflow needs clarification before it can continue with this ticket:",
    input.questions.map((q, i) => `${i + 1}. ${scrubForPublication(q)}`).join("\n"),
  ];

  if (input.suggestedAnswers && input.suggestedAnswers.length > 0) {
    sections.push(
      [
        "Suggested answers:",
        ...input.suggestedAnswers.map((s) => `- ${scrubForPublication(s)}`),
      ].join("\n"),
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

/**
 * Trace posted to the ticket when a clarification is answered somewhere other
 * than the ticket itself, which today means the dashboard. Without it the public
 * questions comment ends in silence: the ticket shows a question, then a status
 * change, and nothing that explains what unblocked the run. The Jira comment
 * path needs no trace, because the human's own comment already is one and this
 * would echo it back at them.
 *
 * The answer is human-authored, not agent-authored, and goes back into the
 * ticket that same human is invited to comment on, so it is published verbatim:
 * scrubbing here would edit a person's own words. Its length is already bounded
 * by MAX_ANSWER_LENGTH where the answer enters.
 */
export function formatClarificationAnswerComment(input: {
  answeredByLabel: string;
  answer: string;
}): string {
  return [
    `${input.answeredByLabel} answered the clarification in the dashboard; the run is resuming.`,
    ["Answer:", input.answer.trim()].join("\n"),
  ].join("\n\n");
}

/** One-liner acknowledging that a clarification was answered and the run resumes. */
export function formatAlreadyAnsweredComment(input: { answeredByLabel: string }): string {
  return `This clarification was already answered by ${input.answeredByLabel}; the run is resuming.`;
}
