import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import type { SettingsResetResponse, SettingsVersionConflict } from "@shared/contracts";
import { parseRequestBody, settingsResetRequestSchema } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { canResetSettings } from "../../../../services/auth/roles.js";
import {
  SettingsValidationError,
  SettingsVersionConflictError,
  resetSetting,
  settingApiEditRefusal,
} from "../../../../services/settings/index.js";

/**
 * Removing one stored setting, so the variable it names or its registry
 * default answers again: the dashboard's "Remove stored value", and the HTTP
 * twin of MCP `settings.reset`, with the same role rule (`canResetSettings`)
 * and the same refusals. The reason is recorded as the key's version row, and a
 * stale `expectedVersion` is answered with 409 exactly as the patch is.
 */
export default defineEventHandler(
  async (event): Promise<SettingsResetResponse | SettingsVersionConflict | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      if (!canResetSettings(actor.role)) {
        throw createError({
          statusCode: 403,
          statusMessage: "Only an owner or an admin can remove a stored setting.",
        });
      }
      const parsed = parseRequestBody(
        settingsResetRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      // A key the running code reads from its environment has nothing here to
      // remove: the resolution ignores a row for it, and the patch refuses to
      // store one. Same sentence, same place to go.
      const refusal = settingApiEditRefusal(parsed.value.key);
      if (refusal !== null) {
        throw createError({ statusCode: 400, statusMessage: refusal });
      }
      const outcome = await resetSetting({
        key: parsed.value.key,
        actor: actor.userId,
        reason: parsed.value.reason,
        expectedVersion: parsed.value.expectedVersion,
      });
      return { removed: outcome.removed, setting: outcome.entry };
    } catch (error) {
      if (error instanceof SettingsVersionConflictError) {
        setResponseStatus(event, 409);
        return { error: "settings_version_conflict", conflicts: error.conflicts };
      }
      if (error instanceof SettingsValidationError) {
        throw createError({ statusCode: 400, statusMessage: error.message });
      }
      toHttpError(error);
    }
  },
);
