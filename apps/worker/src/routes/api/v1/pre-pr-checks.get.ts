import { defineEventHandler } from "h3";
import type { PrePrChecksResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { allowedRepoEnvNames } from "../../../pre-pr-checks/runner.js";
import {
  listPrePrCheckConfigVersions,
  serializePrePrCheckConfigVersion,
} from "../../../pre-pr-checks/store.js";

export default defineEventHandler(async (event): Promise<PrePrChecksResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    const versions = (await listPrePrCheckConfigVersions(getDb())).map(
      serializePrePrCheckConfigVersion,
    );
    return {
      current: versions[0] ?? null,
      versions,
      // The runner's own parse, never a second one: the editor offering a name
      // the batch would refuse is the drift this shares the helper to avoid.
      // Sorted, because the operator's variable is a comma separated string
      // whose order says nothing, and a list that reshuffles between reads
      // makes the picker jump.
      allowedEnv: [...allowedRepoEnvNames()].sort(),
    };
  } catch (error) {
    toHttpError(error);
  }
});
