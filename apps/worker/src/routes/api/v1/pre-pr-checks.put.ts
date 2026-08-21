import { createError, defineEventHandler, readBody } from "h3";
import type { PrePrCheckSaveResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  describePrePrCheckIssues,
  repoScriptsConfigSchema,
  type PrePrCheckConfig,
} from "../../../pre-pr-checks/config.js";
import {
  dashboardUserLabel,
  savePrePrCheckConfig,
  serializePrePrCheckConfigVersion,
} from "../../../pre-pr-checks/store.js";

export default defineEventHandler(async (event): Promise<PrePrCheckSaveResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const body =
      (await readBody<{ config?: PrePrCheckConfig }>(event).catch(() => null)) ?? {};
    // Validated against the repository scripts contract, which accepts both the
    // named-group shape and the legacy flat commands shape, so an editor that
    // still round-trips the old shape keeps saving.
    const submitted = body.config;
    const parsed = repoScriptsConfigSchema.safeParse(submitted);
    if (!parsed.success || submitted === undefined) {
      throw createError({
        statusCode: 400,
        statusMessage: parsed.success
          ? "Invalid config: config is required."
          : `Invalid config: ${describePrePrCheckIssues(parsed.error)}`,
      });
    }
    const dbHandle = getDb();
    const saved = await savePrePrCheckConfig(dbHandle, {
      actorRole: actor.role,
      actorId: actor.userId,
      actorLabel: await dashboardUserLabel(dbHandle, actor.userId),
      // The RAW submitted shape, deliberately not parsed.data.
      //
      // repoScriptsConfigSchema normalizes on the way through: it fills setup
      // and env defaults and rewrites a legacy flat `commands` entry into
      // groups.checks. Storing that normalized value would change the bytes the
      // publication gate fingerprints, and the gate hashes the stored
      // configuration, so every recorded gate would be invalidated by a save
      // that changed nothing an operator typed. Normalization belongs at the
      // engine boundary, where runPrePrChecksWithFixes parses this value again.
      //
      config: submitted,
    });
    return { version: serializePrePrCheckConfigVersion(saved) };
  } catch (error) {
    toHttpError(error);
  }
});
