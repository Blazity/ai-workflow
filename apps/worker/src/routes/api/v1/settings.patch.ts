import { createError, defineEventHandler, readBody } from "h3";
import type { SettingsPatchResponse } from "@shared/contracts";
import {
  findSettingDefinition,
  parseRequestBody,
  settingsPatchRequestSchema,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import { canEditSettings } from "../../../services/auth/roles.js";
import {
  SettingsValidationError,
  updateSettings,
} from "../../../services/settings/index.js";

/**
 * Which keys this route refuses even though the store can write them.
 *
 * Activating the repository catalog decides what the agent may touch at all,
 * and the dialog that does it names every repository holding an active run
 * claim that is not enabled, so the admin sees what the next dispatch stops
 * selecting. A generic patch would flip the same flag with none of that shown,
 * which is why the group is refused here rather than in the store: the
 * activation route of the catalog stage writes it through the same repository.
 */
const NON_PATCHABLE_GROUP = "repositories";

function refusedKeys(patch: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(patch).filter(
    (key) => findSettingDefinition(key)?.group === NON_PATCHABLE_GROUP,
  );
}

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
      const refused = refusedKeys(parsed.value.settings);
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
