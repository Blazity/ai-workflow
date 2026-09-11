/**
 * What the dashboard may read of the harness profiles an organization owns.
 *
 * The stores below take a connection and answer about rows; this binds the
 * connection and decides what a dashboard read means. The detail read returns
 * null for a profile the actor may not see, which is the same answer as one
 * that does not exist: the caller turns both into the one 404.
 */
import { getDb } from "../../db/client.js";
import type { DashboardRole } from "../auth/index.js";
import { getHarnessProfileDetailWithUsage } from "../../db/harness-profile-detail-store.js";
import {
  listHarnessProfiles,
  type HarnessProfileActor,
} from "../../db/repositories/harness-profiles.js";

/** The actor fields every profile operation needs, as the route knows them. */
export type { HarnessProfileActor };

/** The organization's profiles, archived ones only when asked for. */
export function listHarnessProfilesForOrganization(input: {
  organizationId: string;
  includeArchived: boolean;
}) {
  return listHarnessProfiles(getDb(), input);
}

/** One profile with its versions and usage, or null when it names nothing. */
export async function readHarnessProfileDetail(input: {
  organizationId: string;
  profileId: string;
  actorRole: DashboardRole;
  requestedVersion: number | undefined;
}) {
  const detail = await getHarnessProfileDetailWithUsage(getDb(), input);
  return detail ?? null;
}
