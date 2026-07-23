import { createError, defineEventHandler, readBody } from "h3";
import type { HarnessProfilePublishResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { publishHarnessProfile } from "../../../../../harness-profiles/store.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import {
  parseHarnessProfileId,
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "../../harness-profiles.get.js";

export default defineEventHandler(
  async (event): Promise<HarnessProfilePublishResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      const body =
        (await readBody<{ expectedRevision?: unknown }>(event).catch(
          () => null,
        )) ?? {};
      if (typeof body.expectedRevision !== "number") {
        throw createError({
          statusCode: 400,
          statusMessage: "expectedRevision is required",
        });
      }
      return publishHarnessProfile(getDb(), {
        profileId: parseHarnessProfileId(event),
        expectedRevision: body.expectedRevision,
        actor: {
          organizationId: actor.organizationId,
          role: actor.role,
          id: actor.userId,
        },
      });
    } catch (error) {
      toHarnessProfileHttpError(error);
    }
  },
);
