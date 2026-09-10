import { createError, defineEventHandler, getQuery } from "h3";
import type { HarnessProfileDetailResponse } from "@shared/contracts";
import { requireDashboardActor } from "../../../../services/auth/index.js";
import { readHarnessProfileDetail } from "../../../../services/harness/index.js";
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
      const profileId = parseHarnessProfileId(event);
      const detail = await readHarnessProfileDetail({
        organizationId: actor.organizationId,
        profileId,
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
