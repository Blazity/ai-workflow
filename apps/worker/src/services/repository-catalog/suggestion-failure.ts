import { REPOSITORY_SUGGESTION_FAILURE_REASON_MAX_LENGTH } from "@shared/contracts";

const TRUNCATION_MARKER = " [truncated]";

/**
 * The bounded reason safe for a caller or history screen.
 *
 * Input has already passed through the suggestion credential redaction. This
 * boundary only removes surrounding whitespace and applies the smaller public
 * length cap. It must never receive raw provider text.
 */
export function publicSuggestionFailureReason(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= REPOSITORY_SUGGESTION_FAILURE_REASON_MAX_LENGTH) {
    return trimmed;
  }
  return (
    trimmed.slice(
      0,
      REPOSITORY_SUGGESTION_FAILURE_REASON_MAX_LENGTH - TRUNCATION_MARKER.length,
    ) + TRUNCATION_MARKER
  );
}
