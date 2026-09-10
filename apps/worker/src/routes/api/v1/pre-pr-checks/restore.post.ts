import { createError, defineEventHandler, readBody } from "h3";
import type { PrePrCheckSaveResponse } from "@shared/contracts";
import { parseRequestBody, prePrCheckRestoreRequestSchema } from "@shared/contracts";
import { requireDashboardActor, toHttpError } from "../../../../services/auth/index.js";
import { restorePrePrChecksConfiguration } from "../../../../services/pre-pr-checks/index.js";

export default defineEventHandler(async (event): Promise<PrePrCheckSaveResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const parsed = parseRequestBody(
      prePrCheckRestoreRequestSchema,
      (await readBody(event).catch(() => null)) ?? {},
    );
    if (!parsed.ok) {
      throw createError({ statusCode: 400, statusMessage: parsed.message });
    }
    return {
      version: await restorePrePrChecksConfiguration({
        editor: { actorRole: actor.role, actorId: actor.userId },
        version: parsed.value.version,
      }),
    };
  } catch (error) {
    toHttpError(error);
  }
});
