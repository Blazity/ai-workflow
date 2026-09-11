/**
 * Dashboard identity: roles, invites, SSO handoff, trusted origins and the request actor.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  changeDashboardUserRole,
  dashboardActorLabel,
  listDashboardDirectory,
} from "./dashboard-directory.js";
export {
  cancelInviteForActor,
  createInviteForActor,
  listInvitesForActor,
  resendInviteForActor,
} from "./dashboard-invites.js";
export {
  acceptDashboardInvite,
  acceptDashboardSsoInvite,
  getDashboardInviteAcceptanceState,
} from "./invite-acceptance.js";
export {
  acceptDashboardInviteWithPassword,
  acceptDashboardSsoInviteForUser,
  readDashboardInviteAcceptance,
} from "./invite-requests.js";
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
  clearOAuthFlowCookie,
  createOAuthFlowCookie,
  describeOAuthFlowCookie,
  readOAuthFlowCookie,
} from "./oauth-flow-cookie.js";
export type {
  OAuthFlowCookieReason,
} from "./oauth-flow-cookie.js";
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
  isDashboardSsoProviderRegistered,
} from "./sso-provider-status.js";
export {
  dashboardLoginUrl,
  dashboardOriginUrl,
  dashboardSsoCompletionUrl,
  workerOriginUrl,
  workerUrlFor,
} from "./sso-redirects.js";
export {
  buildTrustedOrigins,
} from "./trusted-origins.js";
export {
  listDashboardUsers,
  updateDashboardUserRole,
} from "./users-read.js";
