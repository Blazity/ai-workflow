import { createError, defineEventHandler, readBody } from "h3";
import type {
  HarnessSkillRefreshRequest,
  HarnessSkillRefreshResponse,
} from "@shared/contracts";
import { getDb } from "../../../../../../db/client.js";
import {
  refreshGitHubSkillArtifact,
} from "../../../../../../harness-profiles/github-skills.js";
import { createConfiguredGitHubSkillRepository } from "../../../../../../harness-profiles/configured-github-skills.js";
import {
  HarnessProfileStoreError,
  replaceHarnessProfileSkillArtifact,
} from "../../../../../../harness-profiles/store.js";
import { requireDashboardActor } from "../../../../../../lib/auth/request-context.js";
import { canManageHarnessProfiles } from "../../../../../../lib/auth/roles.js";
import { DashboardAuthError } from "../../../../../../lib/auth/users-read.js";
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
      const body =
        (await readBody<Partial<HarnessSkillRefreshRequest>>(event).catch(
          () => null,
        )) ?? {};
      if (
        typeof body.expectedRevision !== "number" ||
        typeof body.artifactHash !== "string"
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "artifactHash and expectedRevision are required",
        });
      }
      const db = getDb();
      const artifact = await refreshGitHubSkillArtifact(db, {
        repository: createConfiguredGitHubSkillRepository(),
        organizationId: actor.organizationId,
        actorId: actor.userId,
        artifactHash: body.artifactHash,
      });
      return {
        profile: await replaceHarnessProfileSkillArtifact(db, {
          profileId: parseHarnessProfileId(event),
          expectedRevision: body.expectedRevision,
          previousArtifactHash: body.artifactHash,
          nextArtifactHash: artifact.artifactHash,
          actor: {
            organizationId: actor.organizationId,
            role: actor.role,
            id: actor.userId,
          },
        }),
        artifact,
      };
    } catch (error) {
      if (error instanceof HarnessProfileStoreError) {
        toHarnessProfileHttpError(error);
      }
      toHarnessSkillHttpError(error);
    }
  },
);
