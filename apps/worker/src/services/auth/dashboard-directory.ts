/**
 * The dashboard's own user directory, as a request to it is answered.
 *
 * The reads below already decide who may see or change what; this binds them to
 * a connection and to the organization this deployment mints identities for, so
 * no caller has to know either. The role a request asks for is validated by its
 * contract schema before it arrives here.
 */
import { getDb } from "../../db/client.js";
import { dashboardUserLabel } from "../../pre-pr-checks/store.js";
import { dashboardOrganizationSettings } from "../settings/index.js";
import type { DashboardRole } from "./roles.js";
import {
  listDashboardUsers,
  updateDashboardUserRole,
  type DashboardUserRow,
} from "./users-read.js";

/** How the signed-in user is named back to them in the session header. */
export function dashboardActorLabel(userId: string): Promise<string> {
  return dashboardUserLabel(getDb(), userId);
}

/** The directory as an actor of this role is allowed to see it. */
export function listDashboardDirectory(
  actorRole: DashboardRole,
): Promise<DashboardUserRow[]> {
  return listDashboardUsers(getDb(), {
    organizationSlug: dashboardOrganizationSettings().slug,
    actorRole,
  });
}

/** Promote or demote one member, refused below when the actor may not. */
export function changeDashboardUserRole(input: {
  actorRole: DashboardRole;
  targetUserId: string;
  nextRole: "admin" | "member";
}): Promise<{ userId: string; role: Exclude<DashboardRole, "owner"> }> {
  return updateDashboardUserRole(getDb(), {
    organizationSlug: dashboardOrganizationSettings().slug,
    actorRole: input.actorRole,
    targetUserId: input.targetUserId,
    nextRole: input.nextRole,
  });
}
