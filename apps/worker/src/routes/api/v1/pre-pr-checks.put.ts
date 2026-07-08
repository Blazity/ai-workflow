import { createError, defineEventHandler, readBody } from "h3";
import type { PrePrCheckSaveResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  describePrePrCheckIssues,
  prePrCheckConfigSchema,
} from "../../../pre-pr-checks/config.js";
import {
  dashboardUserLabel,
  savePrePrCheckConfig,
  serializePrePrCheckConfigVersion,
} from "../../../pre-pr-checks/store.js";

export default defineEventHandler(async (event): Promise<PrePrCheckSaveResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const body = (await readBody<{ config?: unknown }>(event).catch(() => null)) ?? {};
    const parsed = prePrCheckConfigSchema.safeParse(body.config);
    if (!parsed.success) {
      throw createError({
        statusCode: 400,
        statusMessage: `Invalid config: ${describePrePrCheckIssues(parsed.error)}`,
      });
    }
    const dbHandle = getDb();
    const saved = await savePrePrCheckConfig(dbHandle, {
      actorRole: actor.role,
      actorId: actor.userId,
      actorLabel: await dashboardUserLabel(dbHandle, actor.userId),
      config: parsed.data,
    });
    return { version: serializePrePrCheckConfigVersion(saved) };
  } catch (error) {
    toHttpError(error);
  }
});
