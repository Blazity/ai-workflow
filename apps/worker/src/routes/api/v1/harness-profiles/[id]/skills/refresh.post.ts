import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessProfileSkillRefreshRequestSchema,
  parseRequestBody,
  type HarnessSkillRefreshResponse,
} from "@shared/contracts";
import {
  canManageHarnessProfiles,
  DashboardAuthError,
  requireDashboardActor,
} from "../../../../../../services/auth/index.js";
import {
  HarnessProfileStoreError,
  refreshHarnessProfileSkill,
} from "../../../../../../services/harness/index.js";
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
