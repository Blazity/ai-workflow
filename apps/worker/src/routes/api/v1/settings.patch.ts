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
  settingApiEditRefusal,
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
        // One sentence per key rather than one for the patch: the two reasons
        // this route refuses (a screen of its own, a value the deployment
        // itself reads) send the caller to different places, and a patch can
        // carry both.
        throw createError({
          statusCode: 400,
          statusMessage: refused
            .map((key) => settingApiEditRefusal(key))
            .filter((sentence): sentence is string => sentence !== null)
            .join(" "),
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
