/**
 * Dashboard identity: roles, invites, SSO handoff, trusted origins and the request actor.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
export {
  acceptDashboardInvite,
  acceptDashboardSsoInvite,
  getDashboardInviteAcceptanceState,
} from "./invite-acceptance.js";
export {
  cancelDashboardInvite,
  createDashboardInvite,
  listDashboardInvites,
  resendDashboardInvite,
} from "./invites.js";
export type {
  SendInviteEmail,
} from "./invites.js";
export {
  requireDashboardActor,
  toHttpError,
} from "./request-context.js";
export {
  canApproveWorkflowPlans,
  canDeleteAgentMemory,
  canDispatchWorkflowRuns,
  canEditPrePrChecks,
  canEditPromptLibrary,
  canEditWorkflowDefinitions,
  canInvite,
  canManageHarnessProfiles,
  normalizeDashboardRole,
} from "./roles.js";
export type {
  DashboardRole,
} from "./roles.js";
export {
  resolveSeedAuthEnv,
} from "./seed-auth-env.js";
export {
  consumeDashboardSsoHandoff,
  createDashboardSsoHandoff,
} from "./sso-handoff.js";
export {
  buildTrustedOrigins,
} from "./trusted-origins.js";
export {
  DashboardAuthError,
  listDashboardUsers,
  updateDashboardUserRole,
} from "./users-read.js";
