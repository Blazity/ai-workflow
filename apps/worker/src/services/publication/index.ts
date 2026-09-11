/**
 * Text published outside the worker: scrubbing, branch and check naming, dashboard links and the human-decisions section.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  hasDashboardLinkComment,
  promptLibraryUrl,
  ticketPageUrl,
  ticketRunUrl,
  workflowDefinitionUrl,
} from "./dashboard-links.js";
export {
  renderHumanDecisionsSection,
  upsertHumanDecisionsSection,
} from "./human-decisions-memory.js";
export type {
  HumanDecision,
} from "./human-decisions-memory.js";
export {
  SCRUB_PLACEHOLDER,
  scrubForPublication,
} from "./publication-scrub.js";
export {
  GATE_CHECK_NAME_PREFIX,
  LEGACY_GATE_CHECK_NAME_PREFIX,
  branchForTicket,
  gateCheckNameAliases,
  isManagedBranch,
  isManagedGateCheckName,
  ticketKeyFromBranch,
} from "./workflow-naming.js";
export {
  isWorkflowGeneratedPush,
  workflowPushNormalizationOptions,
  connectedWorkflowPushNormalizationOptions,
} from "./workflow-push-suppression.js";
