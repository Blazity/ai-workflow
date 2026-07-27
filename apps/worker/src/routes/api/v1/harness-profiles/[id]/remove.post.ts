import { defineEventHandler, readBody } from "h3";
import { getDb } from "../../../../../db/client.js";
import { deleteHarnessProfile } from "../../../../../harness-profiles/store.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
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
    await deleteHarnessProfile(getDb(), {
      profileId: parseHarnessProfileId(event),
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
