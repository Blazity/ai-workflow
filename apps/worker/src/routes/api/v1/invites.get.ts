import { defineEventHandler } from "h3";
import { listInvitesForActor } from "../../../services/auth/dashboard-invites.js";
import { getRequestSettingsSnapshot } from "../../../services/settings/index.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    const settings = await getRequestSettingsSnapshot(event);
    const invites = await listInvitesForActor(actor, settings);
    return { invites };
  } catch (error) {
    toHttpError(error);
  }
});
