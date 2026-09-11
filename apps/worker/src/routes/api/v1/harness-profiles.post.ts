import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessProfileCreateRequestSchema,
  parseRequestBody,
  type HarnessProfileMutationResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../services/auth/request-context.js";
import {
  createHarnessProfileDraft,
} from "../../../services/harness/profile-authoring.js";
import {
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "./harness-profiles.get.js";

export default defineEventHandler(
  async (event): Promise<HarnessProfileMutationResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      const parsed = parseRequestBody(
        harnessProfileCreateRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return {
        profile: await createHarnessProfileDraft({
          slug: parsed.value.slug,
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
