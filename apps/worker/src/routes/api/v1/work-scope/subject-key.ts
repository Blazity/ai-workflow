/**
 * Why a subject key in a query string was refused, in words that tell a typo
 * from an omission.
 *
 * One refusal used to cover both, and the cost landed on the typo: a caller who
 * wrote `AWP-261` for `ticket:jira:AWP-261` read "subjectKey is required" about
 * a parameter they had plainly sent, and before the schema knew the subject
 * kinds they were handed a confident empty record instead.
 *
 * The schema's own message names the kinds and shows one, so it is passed
 * through rather than paraphrased here, where it would drift from the rule.
 * Shared by the three routes that take a key in the query string, so a caller
 * mistyping it on any of them reads the same sentence.
 */
export function subjectKeyRefusal(
  value: unknown,
  error: { issues: readonly { message: string }[] },
): string {
  if (typeof value !== "string" || value.trim().length === 0) return "subjectKey is required";
  return error.issues[0]?.message ?? "subjectKey is not a subject key this deployment knows";
}
