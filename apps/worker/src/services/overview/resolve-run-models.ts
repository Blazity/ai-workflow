import { fetchConnectedRunModelEvidence } from "../../db/repositories/runs.js";
import { attributeRunModel } from "./attribute-run-model.js";

/** Presentation policy for the model labels shown on public run reads. */
export async function resolveRunModels(runIds: string[]): Promise<Map<string, string>> {
  const evidence = await fetchConnectedRunModelEvidence(runIds);
  const models = new Map<string, string>();
  for (const [runId, row] of evidence) {
    const model = attributeRunModel(row);
    if (model) models.set(runId, model);
  }
  return models;
}
