/**
 * Text published outside the worker: scrubbing, branch and check naming, dashboard links and the human-decisions section.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
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
} from "./workflow-push-suppression.js";
