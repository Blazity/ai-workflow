import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessSkillImportBodySchema,
  parseRequestBody,
  type HarnessSkillImportRequest,
  type HarnessSkillImportResponse,
} from "@shared/contracts";
import {
  canManageHarnessProfiles,
  DashboardAuthError,
  requireDashboardActor,
} from "../../../../services/auth/index.js";
import { importGitHubSkillSelection } from "../../../../services/harness/index.js";
import { setHarnessApiNoStore } from "../harness-profiles.get.js";
import { toHarnessSkillHttpError } from "./discover.post.js";

export default defineEventHandler(
  async (event): Promise<HarnessSkillImportResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      if (!canManageHarnessProfiles(actor.role)) {
        throw new DashboardAuthError(403, "Forbidden");
      }
      const parsed = parseRequestBody(
        harnessSkillImportBodySchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return {
        artifacts: await importGitHubSkillSelection({
          organizationId: actor.organizationId,
          actorId: actor.userId,
          // The exact shape is the import's own business: it validates the
          // commit and the paths before it reads a byte.
          source: parsed.value.source as HarnessSkillImportRequest["source"],
          paths: parsed.value.paths as HarnessSkillImportRequest["paths"],
        }),
      };
    } catch (error) {
      toHarnessSkillHttpError(error);
    }
  },
);
