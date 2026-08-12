/** Rendered when a run has no attributable model (`Run.model === null`). */
export const UNKNOWN_MODEL_LABEL = "model unknown";

/**
 * The model label for a run row or header. A run whose model could not be
 * attributed from its own record (no persisted model, no harness manifest) reads
 * as an explicit unknown: the API deliberately no longer substitutes the
 * organization default there, because that constant is not an observation of the
 * run and made failed runs look like they had executed on a model they never
 * touched (AIW-253). Every model surface goes through this, so the run list, the
 * ticket runs screen and the run detail header cannot disagree.
 */
export function runModelLabel(model: string | null | undefined): string {
  return model ?? UNKNOWN_MODEL_LABEL;
}
