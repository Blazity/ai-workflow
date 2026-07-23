import { createError, defineEventHandler, readBody } from "h3";
import type {
  HarnessSkillDiscoverRequest,
  HarnessSkillDiscoveryResponse,
} from "@shared/contracts";
import {
  discoverGitHubSkills,
  HarnessSkillImportError,
} from "../../../../harness-profiles/github-skills.js";
import { createConfiguredGitHubSkillRepository } from "../../../../harness-profiles/configured-github-skills.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../lib/auth/request-context.js";
import { canManageHarnessProfiles } from "../../../../lib/auth/roles.js";
import { DashboardAuthError } from "../../../../lib/auth/users-read.js";
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
      const body =
        (await readBody<Partial<HarnessSkillDiscoverRequest>>(event).catch(
          () => null,
        )) ?? {};
      if (typeof body.source !== "string") {
        throw createError({
          statusCode: 400,
          statusMessage: "GitHub skill source is required",
        });
      }
      return discoverGitHubSkills({
        repository: createConfiguredGitHubSkillRepository(),
        source: body.source,
      });
    } catch (error) {
      toHarnessSkillHttpError(error);
    }
  },
);
