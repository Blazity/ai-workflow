/**
 * The dashboard role vocabulary, re-published for this cluster's callers.
 *
 * The definitions moved to `@shared/contracts` in stage 6c so the MCP actor path
 * can normalize a membership row without importing this cluster (and, through
 * it, the Better Auth instance). Nothing here is a second copy: this file is one
 * line of re-export.
 */
export type { DashboardRole } from "@shared/contracts";

// Role parsing is shared by authentication services and engine-owned stores.
export {
  canApproveWorkflowPlans,
  canChangeRole,
  canDeleteAgentMemory,
  canDispatchWorkflowRuns,
  canEditPrePrChecks,
  canEditPromptLibrary,
  canEditWorkflowDefinitions,
  canInvite,
  canManageHarnessProfiles,
  normalizeDashboardRole,
} from "@shared/contracts";
