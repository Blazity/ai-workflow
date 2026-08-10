import { createError, defineEventHandler, readBody } from "h3";
import type {
  HarnessLocalSkillImportRequest,
  HarnessSkillImportResponse,
} from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { importLocalSkills } from "../../../../harness-profiles/local-skills.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { canManageHarnessProfiles } from "../../../../lib/auth/roles.js";
import { DashboardAuthError } from "../../../../lib/auth/users-read.js";
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
      const body =
        (await readBody<Partial<HarnessLocalSkillImportRequest>>(event).catch(
          () => null,
        )) ?? {};
      if (!Array.isArray(body.skills)) {
        throw createError({
          statusCode: 400,
          statusMessage: "Selected skills are required",
        });
      }
      return {
        artifacts: await importLocalSkills(getDb(), {
          organizationId: actor.organizationId,
          actorId: actor.userId,
          skills: body.skills,
        }),
      };
    } catch (error) {
      toHarnessSkillHttpError(error);
    }
  },
);
