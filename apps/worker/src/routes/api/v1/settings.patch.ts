import { createError, defineEventHandler, readBody } from "h3";
import type { SettingsPatchResponse } from "@shared/contracts";
import { parseRequestBody, settingsPatchRequestSchema } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import { canEditSettings } from "../../../services/auth/roles.js";
import {
  SettingsValidationError,
  settingsNotEditableThroughApi,
  updateSettings,
} from "../../../services/settings/index.js";

/** Changing a switch changes it for every run and every user of this
 *  deployment, so it follows the owner/admin rule, and the reason travels with
 *  the change: a behaviour change nobody can explain later is the thing the
 *  version rows exist to prevent. */
export default defineEventHandler(
  async (event): Promise<SettingsPatchResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      if (!canEditSettings(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }
      const parsed = parseRequestBody(
        settingsPatchRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      // The rule itself lives in services/settings/api-editability.ts, because
      // the MCP settings.set tool has to refuse the same keys and two copies of
      // it would be two answers.
      const refused = settingsNotEditableThroughApi(parsed.value.settings);
      if (refused.length > 0) {
        throw createError({
          statusCode: 400,
          statusMessage:
            `Not editable here: ${refused.join(", ")}. ` +
            "Activate the repository catalog from the Repositories page, " +
            "which posts to /api/v1/repository-catalog/activate.",
        });
      }
      return await updateSettings({
        patch: parsed.value.settings,
        actor: actor.userId,
        reason: parsed.value.reason,
      });
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        throw createError({ statusCode: 400, statusMessage: error.message });
      }
      toHttpError(error);
    }
  },
);
