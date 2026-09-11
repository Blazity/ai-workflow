/**
 * Pre-PR checks: what the dashboard may read of the stored check configuration, and how it edits it.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  readPrePrChecksOverview,
  restorePrePrChecksConfiguration,
  savePrePrChecksConfiguration,
} from "./check-configuration.js";
export type {
  PrePrCheckEditor,
  PrePrCheckSaveOutcome,
} from "./check-configuration.js";
