import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import {
  isWorkflowAddressablePathSegment,
  type JsonSchema202012,
  type JsonValue,
  type WorkflowValueSchema,
} from "@shared/contracts";

export type JsonSchemaIssueCode =
  | "invalid_json"
  | "invalid_schema"
  | "unsupported_keyword"
  | "unsupported_type"
  | "invalid_value";

export interface JsonSchemaIssue {
  code: JsonSchemaIssueCode;
  /** RFC 6901 pointer into the schema or value. Empty string means the root. */
  path: string;
  message: string;
}

export type ParsedJsonSchema =
  | {
      ok: true;
      schema: JsonSchema202012;
      valueSchema: WorkflowValueSchema;
    }
  | {
      ok: false;
      issues: JsonSchemaIssue[];
    };

export interface JsonSchemaInspectionOptions {
  /** Provider-equivalent deployable schemas close every object explicitly. */
  requireClosedObjects?: boolean;
  /** Reproduce the schema subset accepted by deployed v1 definitions. */
  legacyCompatibility?: boolean;
}

const ajv = new Ajv2020({
  allErrors: true,
  logger: false,
  strict: false,
  validateFormats: false,
});

const supportedKeywords = new Set([
  "$schema",
  "additionalProperties",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "type",
]);

const supportedTypes = new Set(["array", "boolean", "null", "number", "object", "string"]);

const legacyUnsupportedValidationKeywords = new Set([
  "$defs",
  "$ref",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "dependentRequired",
  "dependencies",
  "definitions",
  "else",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "then",
  "uniqueItems",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function pointer(path: string, segment: string): string {
  return `${path}/${escapePointerSegment(segment)}`;
}

function displayPath(path: string): string {
  if (path === "") return "outputSchema";
  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const keyword = segments.at(-1);
  const owner = keyword && supportedKeywords.has(keyword) ? segments.slice(0, -1) : segments;
  return owner.length === 0 ? "outputSchema" : `outputSchema.${owner.join(".")}`;
}

function issueFromAjv(error: ErrorObject): JsonSchemaIssue {
  let path = error.instancePath;
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    path = pointer(path, error.params.missingProperty);
  }
  return {
    code: "invalid_schema",
    path,
    message: `${displayPath(path)} ${error.message ?? "is invalid"}.`,
  };
}

function schemaRecord(value: unknown): value is JsonSchema202012 {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableBaseType(rawType: unknown): string | null {
  if (typeof rawType === "string") {
    return supportedTypes.has(rawType) ? rawType : null;
  }
  if (!Array.isArray(rawType) || rawType.length !== 2) return null;
  const unique = new Set(rawType);
  if (unique.size !== 2 || !unique.has("null")) return null;
  const base = rawType.find((item) => item !== "null");
  return typeof base === "string" && supportedTypes.has(base) && base !== "null"
    ? base
    : null;
}

function inspectSupportedSubset(
  schema: JsonSchema202012,
  path: string,
  depth: number,
  issues: JsonSchemaIssue[],
  options: JsonSchemaInspectionOptions,
): void {
  if (depth > 32) {
    issues.push({
      code: "invalid_schema",
      path,
      message: `${displayPath(path)} is nested too deeply.`,
    });
    return;
  }

  for (const keyword of Object.keys(schema)) {
    const unsupported = options.legacyCompatibility
      ? legacyUnsupportedValidationKeywords.has(keyword)
      : !supportedKeywords.has(keyword);
    if (unsupported) {
      const keywordPath = pointer(path, keyword);
      issues.push({
        code: "unsupported_keyword",
        path: keywordPath,
        message: `${displayPath(path)} uses unsupported validation keyword "${keyword}".`,
      });
    }
  }

  const baseType = nullableBaseType(schema.type);
  if (baseType === null) {
    const typePath = pointer(path, "type");
    const rendered = JSON.stringify(schema.type);
    issues.push({
      code: "unsupported_type",
      path: typePath,
      message:
        typeof schema.type === "string" || Array.isArray(schema.type)
          ? `${displayPath(typePath)} has unsupported type ${rendered}.`
          : `${displayPath(typePath)} must declare a supported type.`,
    });
    return;
  }

  if (baseType === "array") {
    if (!schemaRecord(schema.items)) {
      const itemsPath = pointer(path, "items");
      issues.push({
        code: "invalid_schema",
        path: itemsPath,
        message: `${displayPath(itemsPath)} must be a JSON Schema object.`,
      });
    } else {
      inspectSupportedSubset(
        schema.items,
        pointer(path, "items"),
        depth + 1,
        issues,
        options,
      );
    }
  }

  if (baseType !== "object") return;
  const rawProperties = schema.properties;
  if (rawProperties !== undefined && !schemaRecord(rawProperties)) {
    const propertiesPath = pointer(path, "properties");
    issues.push({
      code: "invalid_schema",
      path: propertiesPath,
      message: `${displayPath(propertiesPath)} must be an object.`,
    });
    return;
  }
  for (const [name, child] of Object.entries(rawProperties ?? {})) {
    const childPath = pointer(pointer(path, "properties"), name);
    if (!isWorkflowAddressablePathSegment(name)) {
      issues.push({
        code: "invalid_schema",
        path: childPath,
        message: `${displayPath(childPath)} property "${name}" is not addressable.`,
      });
      continue;
    }
    if (!schemaRecord(child)) {
      issues.push({
        code: "invalid_schema",
        path: childPath,
        message: `${displayPath(childPath)} must be a JSON Schema object.`,
      });
      continue;
    }
    inspectSupportedSubset(child, childPath, depth + 1, issues, options);
  }

  if (
    schema.required !== undefined &&
    !Array.isArray(schema.required)
  ) {
    const requiredPath = pointer(path, "required");
    issues.push({
      code: "invalid_schema",
      path: requiredPath,
      message: `${displayPath(path)}.required must contain only declared property names.`,
    });
  } else if (Array.isArray(schema.required)) {
    const declared = new Set(Object.keys(rawProperties ?? {}));
    for (const [index, name] of schema.required.entries()) {
      if (typeof name === "string" && !declared.has(name)) {
        const requiredPath = pointer(pointer(path, "required"), String(index));
        issues.push({
          code: "invalid_schema",
          path: requiredPath,
          message: `${displayPath(path)}.required must contain only declared property names.`,
        });
      }
    }
  }

  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    const additionalPath = pointer(path, "additionalProperties");
    issues.push({
      code: "unsupported_keyword",
      path: additionalPath,
      message: `${displayPath(additionalPath)} only supports a boolean additionalProperties value.`,
    });
  } else if (options.requireClosedObjects && schema.additionalProperties !== false) {
    const additionalPath = pointer(path, "additionalProperties");
    issues.push({
      code: "invalid_schema",
      path: additionalPath,
      message: `${displayPath(path)} must set additionalProperties to false.`,
    });
  }
}

function metadata(schema: JsonSchema202012): Pick<WorkflowValueSchema, "description" | "enum"> {
  return {
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
  };
}

function toValueSchema(schema: JsonSchema202012): WorkflowValueSchema {
  const baseType = nullableBaseType(schema.type);
  if (baseType === null) throw new Error("schema subset was not validated");
  const meta = metadata(schema);
  let value: WorkflowValueSchema;
  switch (baseType) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      value = { type: baseType, ...meta };
      break;
    case "array":
      value = {
        type: "array",
        items: toValueSchema(schema.items as JsonSchema202012),
        ...meta,
      };
      break;
    case "object": {
      const properties = Object.fromEntries(
        Object.entries((schema.properties ?? {}) as Record<string, JsonSchema202012>).map(
          ([name, child]) => [name, toValueSchema(child)],
        ),
      );
      value = {
        type: "object",
        properties,
        required: (schema.required as string[] | undefined) ?? [],
        additionalProperties: schema.additionalProperties !== false,
        ...meta,
      };
      break;
    }
    default:
      throw new Error("unreachable JSON Schema type");
  }
  return Array.isArray(schema.type)
    ? { type: "nullable", value, ...meta }
    : value;
}

export function inspectJsonSchema202012(
  raw: unknown,
  options: JsonSchemaInspectionOptions = {},
): ParsedJsonSchema {
  if (!schemaRecord(raw)) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_schema",
          path: "",
          message: "outputSchema must be a JSON Schema object.",
        },
      ],
    };
  }

  const issues: JsonSchemaIssue[] = [];
  inspectSupportedSubset(raw, "", 0, issues, options);
  if (issues.length > 0) return { ok: false, issues };
  if (options.legacyCompatibility) {
    return { ok: true, schema: raw, valueSchema: toValueSchema(raw) };
  }
  const schemaForMetaValidation = raw;
  let validSchema: boolean;
  try {
    const validation = ajv.validateSchema(schemaForMetaValidation);
    if (typeof validation !== "boolean") throw new Error("async schema validation unsupported");
    validSchema = validation;
  } catch {
    return {
      ok: false,
      issues: [{
        code: "invalid_schema",
        path: "/$schema",
        message: "outputSchema declares an unsupported JSON Schema dialect.",
      }],
    };
  }
  if (!validSchema) {
    return {
      ok: false,
      issues: (ajv.errors ?? []).map(issueFromAjv),
    };
  }
  return { ok: true, schema: raw, valueSchema: toValueSchema(raw) };
}

export function parseJsonSchema202012(
  source: string,
  options: JsonSchemaInspectionOptions = {},
): ParsedJsonSchema {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: "",
          message: "outputSchema is not valid JSON.",
        },
      ],
    };
  }
  return inspectJsonSchema202012(raw, options);
}

function validationIssue(error: ErrorObject): JsonSchemaIssue {
  let path = error.instancePath;
  if (
    (error.keyword === "required" || error.keyword === "additionalProperties") &&
    typeof (error.params.missingProperty ?? error.params.additionalProperty) === "string"
  ) {
    path = pointer(
      path,
      (error.params.missingProperty ?? error.params.additionalProperty) as string,
    );
  }
  return {
    code: "invalid_value",
    path,
    message: `${path === "" ? "output" : `output${path.replace(/\//g, ".")}`} ${
      error.message ?? "is invalid"
    }.`,
  };
}

export function validateJsonSchemaValue(
  schema: JsonSchema202012,
  value: unknown,
): JsonSchemaIssue[] {
  const validate = ajv.compile(withoutDialectMarkers(schema));
  return validate(value) ? [] : (validate.errors ?? []).map(validationIssue);
}

function allowsNull(schema: JsonSchema202012): boolean {
  const typeAllowsNull =
    schema.type === "null" ||
    (Array.isArray(schema.type) && schema.type.includes("null"));
  return (
    typeAllowsNull &&
    (!Array.isArray(schema.enum) || schema.enum.some((value) => value === null))
  );
}

function adaptForCodex(
  schema: JsonSchema202012,
  optionalProperty: boolean,
): JsonSchema202012 {
  const adapted: JsonSchema202012 = { ...schema };
  delete adapted.$schema;
  if (optionalProperty && !allowsNull(schema)) {
    adapted.type =
      typeof schema.type === "string"
        ? [schema.type, "null"]
        : (schema.type as JsonValue[]).includes("null")
          ? schema.type
          : [...(schema.type as JsonValue[]), "null"];
    if (Array.isArray(schema.enum)) {
      adapted.enum = schema.enum.includes(null) ? schema.enum : [...schema.enum, null];
    }
  }
  const baseType = nullableBaseType(schema.type);
  if (baseType === "array" && schemaRecord(schema.items)) {
    adapted.items = adaptForCodex(schema.items, false);
  }
  if (baseType === "object") {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema202012>;
    const canonicalRequired = new Set((schema.required as string[] | undefined) ?? []);
    adapted.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [
        name,
        adaptForCodex(child, !canonicalRequired.has(name)),
      ]),
    );
    adapted.required = Object.keys(properties);
    adapted.additionalProperties = false;
  }
  return adapted;
}

function withoutDialectMarkers(schema: JsonSchema202012): JsonSchema202012 {
  const stripped: JsonSchema202012 = { ...schema };
  delete stripped.$schema;
  if (Array.isArray(schema.required)) {
    stripped.required = [...new Set(schema.required)];
  }
  const baseType = nullableBaseType(schema.type);
  if (baseType === "array" && schemaRecord(schema.items)) {
    stripped.items = withoutDialectMarkers(schema.items);
  }
  if (baseType === "object" && schema.properties !== undefined) {
    const properties = schema.properties as Record<string, JsonSchema202012>;
    stripped.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [
        name,
        withoutDialectMarkers(child),
      ]),
    );
  }
  return stripped;
}

export function jsonSchemaForProvider(
  schema: JsonSchema202012,
  provider: "claude" | "codex",
): JsonSchema202012 {
  return provider === "codex"
    ? adaptForCodex(schema, false)
    : withoutDialectMarkers(schema);
}

function normalizeCodexValue(schema: JsonSchema202012, value: unknown): unknown {
  const baseType = nullableBaseType(schema.type);
  if (baseType === "array" && Array.isArray(value) && schemaRecord(schema.items)) {
    return value.map((item) => normalizeCodexValue(schema.items as JsonSchema202012, item));
  }
  if (
    baseType !== "object" ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  const normalized: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema202012>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  for (const [name, child] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, name)) continue;
    if (normalized[name] === null && !required.has(name) && !allowsNull(child)) {
      delete normalized[name];
    } else {
      normalized[name] = normalizeCodexValue(child, normalized[name]);
    }
  }
  return normalized;
}

export function normalizeJsonSchemaProviderOutput(
  schema: JsonSchema202012,
  provider: "claude" | "codex",
  value: unknown,
): unknown {
  return provider === "codex" ? normalizeCodexValue(schema, value) : value;
}
