import { createError, defineEventHandler, getQuery } from "h3";
import type { HarnessProfileDetailResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { getHarnessProfileDetail } from "../../../../harness-profiles/store.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import {
  parseHarnessProfileId,
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "../harness-profiles.get.js";

export default defineEventHandler(
  async (event): Promise<HarnessProfileDetailResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      const requestedVersionValue = getQuery(event).version;
      const requestedVersion =
        typeof requestedVersionValue === "string" &&
        /^[1-9]\d*$/.test(requestedVersionValue)
          ? Number(requestedVersionValue)
          : undefined;
      if (
        requestedVersionValue !== undefined &&
        (!Number.isSafeInteger(requestedVersion) || requestedVersion! <= 0)
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid profile version",
        });
      }
      const detail = await getHarnessProfileDetail(getDb(), {
        organizationId: actor.organizationId,
        profileId: parseHarnessProfileId(event),
        actorRole: actor.role,
        requestedVersion,
      });
      if (!detail) {
        throw createError({
          statusCode: 404,
          statusMessage: "Profile not found",
        });
      }
      return detail;
    } catch (error) {
      toHarnessProfileHttpError(error);
    }
  },
);
