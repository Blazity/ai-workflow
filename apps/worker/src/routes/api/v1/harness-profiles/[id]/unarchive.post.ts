import { defineEventHandler, readBody } from "h3";
import type { HarnessProfileMutationResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { restoreArchivedHarnessProfile } from "../../../../../harness-profiles/store.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import {
  parseHarnessProfileId,
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "../../harness-profiles.get.js";

export default defineEventHandler(
  async (event): Promise<HarnessProfileMutationResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      const body = await readBody<{ expectedRevision?: number }>(event);
      return {
        profile: await restoreArchivedHarnessProfile(getDb(), {
          profileId: parseHarnessProfileId(event),
          expectedRevision: body.expectedRevision ?? Number.NaN,
          actor: {
            organizationId: actor.organizationId,
            role: actor.role,
            id: actor.userId,
          },
        }),
      };
    } catch (error) {
      toHarnessProfileHttpError(error);
    }
  },
);
