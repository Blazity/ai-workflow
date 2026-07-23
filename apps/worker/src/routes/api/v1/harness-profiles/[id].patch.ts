import { createError, defineEventHandler, readBody } from "h3";
import type { HarnessProfileMutationResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { updateHarnessProfileDraft } from "../../../../harness-profiles/store.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
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
      const body =
        (await readBody<{
          expectedRevision?: unknown;
          draft?: unknown;
        }>(event).catch(() => null)) ?? {};
      if (
        typeof body.expectedRevision !== "number" ||
        body.draft === undefined
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "Draft and expectedRevision are required",
        });
      }
      return {
        profile: await updateHarnessProfileDraft(getDb(), {
          profileId: parseHarnessProfileId(event),
          expectedRevision: body.expectedRevision,
          draft: body.draft,
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
