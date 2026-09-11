import { defineEventHandler } from "h3";
import type { PrePrChecksResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  readPrePrChecksOverview,
} from "../../../services/pre-pr-checks/check-configuration.js";

export default defineEventHandler(async (event): Promise<PrePrChecksResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    return await readPrePrChecksOverview();
  } catch (error) {
    toHttpError(error);
  }
});
