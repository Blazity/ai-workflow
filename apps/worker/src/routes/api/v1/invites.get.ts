import { defineEventHandler } from "h3";
import {
  listInvitesForActor,
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/index.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    const invites = await listInvitesForActor(actor);
    return { invites };
  } catch (error) {
    toHttpError(error);
  }
});
