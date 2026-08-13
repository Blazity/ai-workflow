/**
 * Sentences for the codes the answer endpoint replies with.
 *
 * The worker answers with machine codes (`already_answered`, `ticket_gone`, ...)
 * and the panel used to render them raw, so a client trying to unstick a run met a
 * red bar reading "ticket_gone" and had no idea whether they had broken something.
 * Each sentence says what happened and what, if anything, the person should do.
 */
const MESSAGES: Record<string, string> = {
  already_answered:
    "This question has already been answered. The run has not picked the answer up yet, which it retries by itself. Use Retry resume run to push it again; there is no need to write a new answer.",
  ticket_gone:
    "The Jira ticket this question belongs to no longer exists, so the answer cannot be delivered. The run is being closed and its execution slot released.",
  clarification_transition_failed:
    "The ticket could not be moved back into the AI column, so the answer was not delivered. Nothing was lost: try again in a moment.",
  clarification_resume_failed:
    "The answer was saved but the run did not wake up. It is retried automatically, and Retry resume run sends it again straight away.",
  invalid_answer: "The answer is empty or too long.",
};

/**
 * Falls through unchanged for anything unmapped: an unrecognized message is far
 * more likely to be a real sentence from somewhere else in the stack than a code,
 * and swallowing it would hide the only detail the reader has.
 */
export function clarificationAnswerErrorMessage(raw: string): string {
  return MESSAGES[raw.trim()] ?? raw;
}
