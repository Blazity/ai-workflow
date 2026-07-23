import type { ClarificationStatus, RunStatus } from "@shared/contracts";

/** What the clarification answer panel on the run trace screen should render. */
export type AnswerPanelMode = "hidden" | "form" | "resumed" | "retry";

/**
 * Decide the panel state from the clarification status and the LIVE run
 * status. The clarification's `dispatchedRunId` is deprecated and always null
 * under the hook-resume design (the asking run resumes in place), so the run
 * status is the honest signal for whether the saved answer actually woke the
 * run up: anything but "awaiting" means it did.
 *
 * `submittedNow` marks a successful in-page submit. Both the clarification
 * prop and the run prop can lag until the next poll, so a fresh submit
 * renders as resumed instead of flashing the retry state.
 */
export function answerPanelMode(
  clarificationStatus: ClarificationStatus,
  runStatus: RunStatus,
  submittedNow: boolean,
): AnswerPanelMode {
  if (clarificationStatus === "superseded") return "hidden";
  if (submittedNow) return "resumed";
  if (clarificationStatus === "pending") return "form";
  return runStatus === "awaiting" ? "retry" : "resumed";
}
