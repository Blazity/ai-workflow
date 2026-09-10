import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessProfileDraftUpdateRequestSchema,
  parseRequestBody,
  type HarnessProfileMutationResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../services/auth/index.js";
import { saveHarnessProfileDraft } from "../../../../services/harness/index.js";
import {
  parseHarnessProfileId,
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "../harness-profiles.get.js";

export default defineEventHandler(
  async (event): Promise<HarnessProfileMutationResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      const parsed = parseRequestBody(
        harnessProfileDraftUpdateRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return {
        profile: await saveHarnessProfileDraft({
          profileId: parseHarnessProfileId(event),
          expectedRevision: parsed.value.expectedRevision,
          draft: parsed.value.draft,
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
