import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessSkillDiscoverBodySchema,
  parseRequestBody,
  type HarnessSkillDiscoveryResponse,
} from "@shared/contracts";
import {
  canManageHarnessProfiles,
  DashboardAuthError,
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/index.js";
import {
  discoverGitHubSkillSource,
  HarnessSkillImportError,
} from "../../../../services/harness/index.js";
import { setHarnessApiNoStore } from "../harness-profiles.get.js";

export function toHarnessSkillHttpError(error: unknown): never {
  if (error instanceof HarnessSkillImportError) {
    throw createError({
      statusCode: error.statusCode,
      statusMessage: error.message,
    });
  }
  toHttpError(error);
}

export default defineEventHandler(
  async (event): Promise<HarnessSkillDiscoveryResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      if (!canManageHarnessProfiles(actor.role)) {
        throw new DashboardAuthError(403, "Forbidden");
      }
      const parsed = parseRequestBody(
        harnessSkillDiscoverBodySchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await discoverGitHubSkillSource(parsed.value.source);
    } catch (error) {
      toHarnessSkillHttpError(error);
    }
  },
);
