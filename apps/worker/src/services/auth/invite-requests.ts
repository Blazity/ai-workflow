/**
 * Invite acceptance as a request, with the deployment's own organization bound.
 *
 * The acceptance rules live next door and take a connection and an organization
 * slug; this is where those two come from, so that a route can ask about an
 * invite without knowing which organization this deployment mints invites for
 * or which database holds them. The Better Auth instance still arrives from the
 * caller: it is built in the app tier, and no service constructs one.
 */
import { getDb } from "../../db/client.js";
import { dashboardOrganizationSettings } from "../settings/index.js";
import {
  acceptDashboardInvite,
  acceptDashboardSsoInvite,
  getDashboardInviteAcceptanceState,
  type AcceptDashboardInviteResult,
  type DashboardInviteAcceptanceState,
} from "./invite-acceptance.js";

/**
 * The Better Auth instance, taken structurally from the function it is handed
 * to. Naming the type would import the app tier into a service, and this
 * cluster's ceiling on that edge is already at its baseline.
 */
type Auth = Parameters<typeof acceptDashboardInvite>[1];

/** What the acceptance screen renders: who the invite is for, and how they sign in. */
export function readDashboardInviteAcceptance(
  auth: Auth,
  inviteId: string,
): Promise<DashboardInviteAcceptanceState> {
  return getDashboardInviteAcceptanceState(getDb(), auth, {
    organizationSlug: dashboardOrganizationSettings().slug,
    inviteId,
  });
}

/** Accept an invite by setting a password, which also creates the session. */
export function acceptDashboardInviteWithPassword(
  auth: Auth,
  input: { inviteId: string; name?: string; password: string },
): Promise<AcceptDashboardInviteResult> {
  return acceptDashboardInvite(getDb(), auth, {
    organizationSlug: dashboardOrganizationSettings().slug,
    inviteId: input.inviteId,
    name: input.name,
    password: input.password,
  });
}

/** Accept an invite on behalf of a user who has just signed in through SSO. */
export function acceptDashboardSsoInviteForUser(
  auth: Auth,
  input: { inviteId: string; user: { id: string; email: string } },
): Promise<void> {
  return acceptDashboardSsoInvite(getDb(), auth, {
    organizationSlug: dashboardOrganizationSettings().slug,
    inviteId: input.inviteId,
    user: input.user,
  });
}
