import { defineEventHandler } from "h3";
import type { HarnessLocalSkillDiscoveryResponse } from "@shared/contracts";
import { discoverLocalSkills } from "../../../../harness-profiles/local-skills.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { canManageHarnessProfiles } from "../../../../lib/auth/roles.js";
import { DashboardAuthError } from "../../../../lib/auth/users-read.js";
import { setHarnessApiNoStore } from "../harness-profiles.get.js";
import { toHarnessSkillHttpError } from "./discover.post.js";

/**
 * Discovering the skills this deployment ships. Unlike the GitHub sibling there
 * is nothing to submit, and nothing to configure: the source is the bundle this
 * function runs from, so a tenant with no GitHub App installation reaches its
 * skills through here.
 */
export default defineEventHandler(
  async (event): Promise<HarnessLocalSkillDiscoveryResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      if (!canManageHarnessProfiles(actor.role)) {
        throw new DashboardAuthError(403, "Forbidden");
      }
      return discoverLocalSkills();
    } catch (error) {
      toHarnessSkillHttpError(error);
    }
  },
);
