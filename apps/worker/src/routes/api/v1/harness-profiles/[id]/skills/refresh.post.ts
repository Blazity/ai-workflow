import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessProfileSkillRefreshRequestSchema,
  parseRequestBody,
  type HarnessSkillRefreshResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
} from "../../../../../../services/auth/request-context.js";
import { canManageHarnessProfiles } from "../../../../../../services/auth/roles.js";
import { DashboardAuthError } from "@shared/contracts";
import { HarnessProfileStoreError } from "../../../../../../services/harness/harness-errors.js";
import {
  refreshHarnessProfileSkill,
} from "../../../../../../services/harness/profile-authoring.js";
import {
  parseHarnessProfileId,
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "../../../harness-profiles.get.js";
import { toHarnessSkillHttpError } from "../../../harness-skills/discover.post.js";

export default defineEventHandler(
  async (event): Promise<HarnessSkillRefreshResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      if (!canManageHarnessProfiles(actor.role)) {
        throw new DashboardAuthError(403, "Forbidden");
      }
      const parsed = parseRequestBody(
        harnessProfileSkillRefreshRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await refreshHarnessProfileSkill({
        profileId: parseHarnessProfileId(event),
        expectedRevision: parsed.value.expectedRevision,
        artifactHash: parsed.value.artifactHash,
        actor: {
          organizationId: actor.organizationId,
          role: actor.role,
          id: actor.userId,
        },
      });
    } catch (error) {
      if (error instanceof HarnessProfileStoreError) {
        toHarnessProfileHttpError(error);
      }
      toHarnessSkillHttpError(error);
    }
  },
);
