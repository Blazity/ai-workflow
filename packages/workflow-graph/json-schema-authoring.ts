/**
 * The authoring-time reading of a JSON Schema an operator typed: the byte
 * ceiling, the JSON parse and the dialect the editor reports back.
 *
 * The schema itself is read through the injected JSON Schema support, because
 * ajv stays in the worker (`json-schema-support.ts` states why).
 */
import type {
  JsonSchema202012,
  JsonSchemaAuthoringInspectionResponse,
} from "@shared/contracts";
import type { WorkflowJsonSchemaSupport } from "./json-schema-support";

const JSON_SCHEMA_2020_12_DIALECT =
  "https://json-schema.org/draft/2020-12/schema" as const;
export const MAX_AUTHORED_JSON_SCHEMA_BYTES = 256 * 1024;

export function inspectAuthoredJsonSchema(
  source: string,
  jsonSchema: WorkflowJsonSchemaSupport,
): JsonSchemaAuthoringInspectionResponse {
  // `TextEncoder` rather than `Buffer`: the same UTF-8 byte count without a
  // Node built-in, which this package may not reach for.
  if (new TextEncoder().encode(source).length > MAX_AUTHORED_JSON_SCHEMA_BYTES) {
    return {
      deployable: false,
      dialect: JSON_SCHEMA_2020_12_DIALECT,
      schema: null,
      valueSchema: null,
      issues: [
        {
          code: "invalid_schema",
          path: "",
          message: "outputSchema must not exceed 256 KiB.",
        },
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return {
      deployable: false,
      dialect: JSON_SCHEMA_2020_12_DIALECT,
      schema: null,
      valueSchema: null,
      issues: [
        {
          code: "invalid_json",
          path: "",
          message: "outputSchema is not valid JSON.",
        },
      ],
    };
  }

  const inspected = jsonSchema.inspect(raw);
  if (!inspected.ok) {
    return {
      deployable: false,
      dialect: JSON_SCHEMA_2020_12_DIALECT,
      schema:
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as JsonSchema202012)
          : null,
      valueSchema: null,
      issues: inspected.issues.map((issue) => ({
        code: issue.code === "invalid_value" ? "invalid_schema" : issue.code,
        path: issue.path,
        message: issue.message,
      })),
    };
  }

  return {
    deployable: true,
    dialect: JSON_SCHEMA_2020_12_DIALECT,
    schema: inspected.schema,
    valueSchema: inspected.valueSchema,
    issues: [],
  };
}
