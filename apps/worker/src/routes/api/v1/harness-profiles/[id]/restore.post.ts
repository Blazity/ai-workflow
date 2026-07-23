import { createError, defineEventHandler, readBody } from "h3";
import type { HarnessProfileMutationResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { restoreHarnessProfileVersion } from "../../../../../harness-profiles/store.js";
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
          version?: unknown;
          expectedRevision?: unknown;
        }>(event).catch(() => null)) ?? {};
      if (
        typeof body.version !== "number" ||
        typeof body.expectedRevision !== "number"
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "version and expectedRevision are required",
        });
      }
      return {
        profile: await restoreHarnessProfileVersion(getDb(), {
          profileId: parseHarnessProfileId(event),
          version: body.version,
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
