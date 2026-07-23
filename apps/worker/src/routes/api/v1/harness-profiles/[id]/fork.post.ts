import { createError, defineEventHandler, readBody } from "h3";
import type { HarnessProfileMutationResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { forkHarnessProfile } from "../../../../../harness-profiles/store.js";
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
      const body =
        (await readBody<{
          slug?: unknown;
          expectedRevision?: unknown;
        }>(event).catch(() => null)) ?? {};
      if (
        typeof body.expectedRevision !== "number"
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "expectedRevision is required",
        });
      }
      return {
        profile: await forkHarnessProfile(getDb(), {
          profileId: parseHarnessProfileId(event),
          slug: body.slug,
          expectedRevision: body.expectedRevision,
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
