import { createError, defineEventHandler, getQuery } from "h3";
import type { SettingsReadResponse, SettingsVersionsResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  SettingsValidationError,
  readSettings,
  readSettingsHistory,
} from "../../../services/settings/index.js";

/** Reading what the deployment is configured to do is open to every role:
 *  a member who cannot change a limit still has to know which one is in force.
 *  Without `key` the answer is every setting; with it, that key's history. */
export default defineEventHandler(
  async (event): Promise<SettingsReadResponse | SettingsVersionsResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const key = getQuery(event).key;
      if (typeof key === "string" && key.length > 0) {
        return await readSettingsHistory(key);
      }
      return await readSettings();
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        throw createError({ statusCode: 400, statusMessage: error.message });
      }
      toHttpError(error);
    }
  },
);
