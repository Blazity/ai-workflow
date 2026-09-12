/**
 * The JSON Schema facility the graph rules borrow, declared structurally and
 * never implemented here.
 *
 * A transform's expected schema, a block's authored output schema and a value
 * measured against one are all JSON Schema 2020-12 questions, and the only
 * answer this repository trusts comes from ajv
 * (`apps/worker/src/engine/definition/json-schema.ts`). ajv is a runtime
 * dependency of the worker, so the package takes the three entry points as a
 * parameter the same way `graph-issues.ts` takes the transform shape validator
 * and `policies.ts` takes the deployment issue source: the rules here state
 * what they need and never learn what backs it.
 *
 * The shapes below restate the worker's `JsonSchemaIssue`, `ParsedJsonSchema`
 * and `JsonSchemaInspectionOptions` rather than importing them. The worker's
 * concrete types satisfy these structurally, so the adapter is the module
 * object itself and no value is ever converted at the seam.
 */
import type {
  JsonSchema202012,
  WorkflowValueSchema,
} from "@shared/contracts";

/** One complaint about a schema, or about a value measured against one. */
export interface WorkflowJsonSchemaIssue {
  code:
    | "invalid_json"
    | "invalid_schema"
    | "unsupported_keyword"
    | "unsupported_type"
    | "invalid_value";
  /** RFC 6901 pointer into the schema or value. Empty string means the root. */
  path: string;
  message: string;
}

/** A schema read into the pair the graph works from: the JSON Schema itself and
 *  the workflow value schema the editor and the binding rules compare. */
export type WorkflowParsedJsonSchema =
  | {
      ok: true;
      schema: JsonSchema202012;
      valueSchema: WorkflowValueSchema;
    }
  | {
      ok: false;
      issues: WorkflowJsonSchemaIssue[];
    };

export interface WorkflowJsonSchemaInspectionOptions {
  /** Provider-equivalent deployable schemas close every object explicitly. */
  requireClosedObjects?: boolean;
  /** Reproduce the schema subset accepted by deployed v1 definitions. */
  legacyCompatibility?: boolean;
}

/**
 * The three questions the graph rules ask about JSON Schema: read an already
 * parsed value as a schema, read a source string as one, and measure a value
 * against a schema.
 */
export interface WorkflowJsonSchemaSupport {
  inspect(
    raw: unknown,
    options?: WorkflowJsonSchemaInspectionOptions,
  ): WorkflowParsedJsonSchema;
  parse(
    source: string,
    options?: WorkflowJsonSchemaInspectionOptions,
  ): WorkflowParsedJsonSchema;
  validateValue(
    schema: JsonSchema202012,
    value: unknown,
  ): WorkflowJsonSchemaIssue[];
}
