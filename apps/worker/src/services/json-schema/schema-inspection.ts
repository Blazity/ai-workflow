/**
 * What an authored JSON Schema means before it is deployed.
 *
 * The inspection itself lives with the workflow definition rules, since a
 * schema is only deployable if the definition runtime can honour every keyword
 * in it. This is the seam the dashboard reads it through, so the transport asks
 * a question about a schema rather than reaching into the definition engine.
 */
import type { JsonSchemaAuthoringInspectionResponse } from "@shared/contracts";
import { inspectAuthoredJsonSchema } from "../../workflow-definition/json-schema-authoring.js";

/** Report the dialect, the usable value schema and every blocking issue. */
export function inspectJsonSchemaSource(
  source: string,
): JsonSchemaAuthoringInspectionResponse {
  return inspectAuthoredJsonSchema(source);
}
