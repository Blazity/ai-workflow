import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessProfileUncheckedRevisionRequestSchema,
  parseRequestBody,
  type HarnessProfileMutationResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/request-context.js";
import {
  unarchiveHarnessProfileDraft,
} from "../../../../../services/harness/profile-authoring.js";
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
      const parsed = parseRequestBody(
        harnessProfileUncheckedRevisionRequestSchema,
        await readBody(event),
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return {
        profile: await unarchiveHarnessProfileDraft({
          profileId: parseHarnessProfileId(event),
          expectedRevision: parsed.value.expectedRevision,
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
