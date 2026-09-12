/**
 * The JSON Schema facility `@shared/workflow-graph` takes as a parameter, bound
 * to this worker's ajv.
 *
 * The graph rules ask three JSON Schema questions (read a value as a schema,
 * read a source string as one, measure a value against one) and answer none of
 * them: ajv is a Node dependency and assumption A2 of the workflow-graph plan
 * keeps it in the worker. This is the whole adapter. The functions already have
 * the shape the package declares, so nothing is converted here and there is no
 * behaviour to test at the seam beyond the suites that already cover
 * `json-schema.ts`.
 */
import type { WorkflowJsonSchemaSupport } from "@shared/workflow-graph";
import {
  inspectJsonSchema202012,
  parseJsonSchema202012,
  validateJsonSchemaValue,
} from "./json-schema.js";

export const JSON_SCHEMA_SUPPORT: WorkflowJsonSchemaSupport = {
  inspect: inspectJsonSchema202012,
  parse: parseJsonSchema202012,
  validateValue: validateJsonSchemaValue,
};
