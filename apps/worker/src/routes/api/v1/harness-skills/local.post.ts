import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessLocalSkillImportBodySchema,
  parseRequestBody,
  type HarnessLocalSkillImportRequest,
  type HarnessSkillImportResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../services/auth/request-context.js";
import { canManageHarnessProfiles } from "../../../../services/auth/roles.js";
import { DashboardAuthError } from "@shared/contracts";
import { importDeploymentSkills } from "../../../../services/harness/skill-sources.js";
import { setHarnessApiNoStore } from "../harness-profiles.get.js";
import { toHarnessSkillHttpError } from "./discover.post.js";

/**
 * Importing deployment skills. The selection carries the hash discovery
 * reported, which is what the GitHub sibling's exact commit does for it: a
 * deployment promoted between the two calls is caught, not imported silently.
 */
export default defineEventHandler(
  async (event): Promise<HarnessSkillImportResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      if (!canManageHarnessProfiles(actor.role)) {
        throw new DashboardAuthError(403, "Forbidden");
      }
      const parsed = parseRequestBody(
        harnessLocalSkillImportBodySchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return {
        artifacts: await importDeploymentSkills({
          organizationId: actor.organizationId,
          actorId: actor.userId,
          // The selection shape is the import's own business: it checks each
          // entry against what this deployment actually ships.
          skills: parsed.value
            .skills as HarnessLocalSkillImportRequest["skills"],
        }),
      };
    } catch (error) {
      toHarnessSkillHttpError(error);
    }
  },
);
