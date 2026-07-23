import { createError, defineEventHandler, readBody } from "h3";
import type {
  HarnessProfileMutationResponse,
} from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { createHarnessProfile } from "../../../harness-profiles/store.js";
import { requireDashboardActor } from "../../../lib/auth/request-context.js";
import {
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "./harness-profiles.get.js";

export default defineEventHandler(
  async (event): Promise<HarnessProfileMutationResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      const body =
        (await readBody<{ slug?: unknown; draft?: unknown }>(event).catch(
          () => null,
        )) ?? {};
      if (body.draft === undefined) {
        throw createError({
          statusCode: 400,
          statusMessage: "Profile draft is required",
        });
      }
      return {
        profile: await createHarnessProfile(getDb(), {
          slug: body.slug,
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
