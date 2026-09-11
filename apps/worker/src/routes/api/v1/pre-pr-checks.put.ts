import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import type { PrePrCheckSaveConflict, PrePrCheckSaveResponse } from "@shared/contracts";
import { parseRequestBody, prePrCheckSaveRequestSchema } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  savePrePrChecksConfiguration,
} from "../../../services/pre-pr-checks/check-configuration.js";

export default defineEventHandler(async (
  event,
): Promise<PrePrCheckSaveResponse | PrePrCheckSaveConflict | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const parsed = parseRequestBody(
      prePrCheckSaveRequestSchema,
      (await readBody(event).catch(() => null)) ?? {},
    );
    if (!parsed.ok) {
      throw createError({ statusCode: 400, statusMessage: parsed.message });
    }
    const outcome = await savePrePrChecksConfiguration({
      editor: { actorRole: actor.role, actorId: actor.userId },
      config: parsed.value.config,
      baseVersion: parsed.value.baseVersion,
    });
    if (outcome.kind === "invalid") {
      throw createError({ statusCode: 400, statusMessage: outcome.message });
    }
    if (outcome.kind === "version_conflict") {
      setResponseStatus(event, 409);
      return { error: "version_conflict", latestVersion: outcome.latestVersion };
    }
    return { version: outcome.version };
  } catch (error) {
    toHttpError(error);
  }
});
