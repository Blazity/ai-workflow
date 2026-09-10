import { defineEventHandler } from "h3";
import { requireDashboardActor } from "../../../../services/auth/index.js";
import { archiveWorkflowDefinitionById } from "../../../../services/workflow-definitions/index.js";
import { parseDefinitionId, toWorkflowDefinitionHttpError } from "../workflow-definitions.get.js";

export default defineEventHandler(async (event): Promise<{ ok: true } | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const id = parseDefinitionId(event);
    await archiveWorkflowDefinitionById({
      definitionId: id,
      actor: { role: actor.role, userId: actor.userId },
    });
    return { ok: true };
  } catch (error) {
    toWorkflowDefinitionHttpError(error);
  }
});
