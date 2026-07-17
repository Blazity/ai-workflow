import { defineEventHandler } from "h3";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import { archiveWorkflowDefinition } from "../../../../workflow-definition/store.js";
import { parseDefinitionId, toWorkflowDefinitionHttpError } from "../workflow-definitions.get.js";

export default defineEventHandler(async (event): Promise<{ ok: true } | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const id = parseDefinitionId(event);
    const dbHandle = getDb();
    await archiveWorkflowDefinition(dbHandle, {
      definitionId: id,
      actor: {
        role: actor.role,
        id: actor.userId,
        label: await dashboardUserLabel(dbHandle, actor.userId),
      },
    });
    return { ok: true };
  } catch (error) {
    toWorkflowDefinitionHttpError(error);
  }
});
