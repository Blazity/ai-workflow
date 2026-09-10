import { defineEventHandler, readBody } from "h3";
import { getDb } from "../../../../../db/client.js";
import { deleteHarnessProfileWithUsage } from "../../../../../db/harness-profile-detail-store.js";
import { requireDashboardActor } from "../../../../../services/auth/request-context.js";
import {
  parseHarnessProfileId,
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "../../harness-profiles.get.js";

export default defineEventHandler(async (event) => {
  try {
    setHarnessApiNoStore(event);
    const actor = await requireDashboardActor(event);
    const body = await readBody<{ expectedRevision?: number }>(event);
    const db = getDb();
    const profileId = parseHarnessProfileId(event);
    await deleteHarnessProfileWithUsage(db, {
      profileId,
      expectedRevision: body.expectedRevision ?? Number.NaN,
      actor: {
        organizationId: actor.organizationId,
        role: actor.role,
        id: actor.userId,
      },
    });
    return { deleted: true };
  } catch (error) {
    toHarnessProfileHttpError(error);
  }
});
