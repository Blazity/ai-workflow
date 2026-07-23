import { createError, defineEventHandler, readBody } from "h3";
import type {
  HarnessSkillImportRequest,
  HarnessSkillImportResponse,
} from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import {
  importGitHubSkills,
} from "../../../../harness-profiles/github-skills.js";
import { createConfiguredGitHubSkillRepository } from "../../../../harness-profiles/configured-github-skills.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { canManageHarnessProfiles } from "../../../../lib/auth/roles.js";
import { DashboardAuthError } from "../../../../lib/auth/users-read.js";
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
      const body =
        (await readBody<Partial<HarnessSkillImportRequest>>(event).catch(
          () => null,
        )) ?? {};
      if (
        !body.source ||
        typeof body.source !== "object" ||
        !Array.isArray(body.paths)
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "Exact source and selected paths are required",
        });
      }
      return {
        artifacts: await importGitHubSkills(getDb(), {
          repository: createConfiguredGitHubSkillRepository(),
          organizationId: actor.organizationId,
          actorId: actor.userId,
          request: {
            source: body.source as HarnessSkillImportRequest["source"],
            paths: body.paths,
          },
        }),
      };
    } catch (error) {
      toHarnessSkillHttpError(error);
    }
  },
);
