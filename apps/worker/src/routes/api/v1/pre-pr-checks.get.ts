import { defineEventHandler } from "h3";
import type { PrePrChecksResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  listPrePrCheckConfigVersions,
  serializePrePrCheckConfigVersion,
} from "../../../pre-pr-checks/store.js";

export default defineEventHandler(async (event): Promise<PrePrChecksResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    const versions = (await listPrePrCheckConfigVersions(getDb())).map(
      serializePrePrCheckConfigVersion,
    );
    return { current: versions[0] ?? null, versions };
  } catch (error) {
    toHttpError(error);
  }
});
