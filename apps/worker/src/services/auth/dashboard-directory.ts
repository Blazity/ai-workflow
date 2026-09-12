/**
 * The dashboard's own user directory, as a request to it is answered.
 *
 * The reads below already decide who may see or change what; this binds them to
 * a connection and to the organization this deployment mints identities for, so
 * no caller has to know either. The role a request asks for is validated by its
 * contract schema before it arrives here.
 */
import type { SettingsSnapshot } from "@shared/contracts";
import { getConnectedDashboardUserLabel } from "../../db/repositories/auth.js";
import { dashboardOrganizationSettings } from "../settings/index.js";
import type { DashboardRole } from "./roles.js";
import {
  listConnectedDashboardUsers,
  updateConnectedDashboardUserRole,
  type DashboardUserRow,
} from "./users-read.js";

/** How the signed-in user is named back to them in the session header. */
export function dashboardActorLabel(userId: string): Promise<string> {
  return getConnectedDashboardUserLabel(userId);
}

/** The directory as an actor of this role is allowed to see it. */
export function listDashboardDirectory(
  actorRole: DashboardRole,
  settings: SettingsSnapshot,
): Promise<DashboardUserRow[]> {
  return listConnectedDashboardUsers({
    organizationSlug: dashboardOrganizationSettings(settings).slug,
    actorRole,
  });
}

/** Promote or demote one member, refused below when the actor may not. */
export function changeDashboardUserRole(input: {
  actorRole: DashboardRole;
  targetUserId: string;
  nextRole: "admin" | "member";
  settings: SettingsSnapshot;
}): Promise<{ userId: string; role: Exclude<DashboardRole, "owner"> }> {
  return updateConnectedDashboardUserRole({
    organizationSlug: dashboardOrganizationSettings(input.settings).slug,
    actorRole: input.actorRole,
    targetUserId: input.targetUserId,
    nextRole: input.nextRole,
  });
}
