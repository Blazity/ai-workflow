import {
  isWorkflowAddressablePathSegment,
  type JsonSchema202012,
  type JsonValue,
  type TransformConfiguration,
} from "@shared/contracts";
import {
  parseJsonSchema202012,
  validateJsonSchemaValue,
} from "./json-schema.js";
import {
  resolveWorkflowDataReferenceV2,
  resolveWorkflowPromptDataTokensV2,
  type V2BindingResolutionContext,
} from "./v2-bindings.js";
import { replaceTextRegexStep } from "./transform-regex-step.js";

const MAX_FIELDS = 100;
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const UNSAFE_FIELDS = new Set(["__proto__", "prototype", "constructor"]);

export interface TransformIssue {
  code:
    | "invalid_configuration"
    | "invalid_path"
    | "incompatible_value"
    | "unsafe_output_field";
  path: string;
  message: string;
}

export interface TransformDefinition {
  configuration: TransformConfiguration;
  referenceSchemas?: Readonly<
    Record<
      string,
      {
        schema: JsonSchema202012;
        required: boolean;
      }
    >
  >;
}

export class TransformExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformExecutionError";
  }
}

function pointer(path: string, segment: string | number): string {
  return `${path}/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function scalarSchema(value: string | number | boolean | null): JsonSchema202012 {
  return value === null ? { type: "null" } : { type: typeof value };
}

function isSupportedRegex(pattern: string): boolean {
  if (
    /\\[1-9]|\\k<|\(\?(?:[=!]|<[=!])|\(\?>|\(\?[imsux-]/.test(pattern)
  ) {
    return false;
  }
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

export function validateTransformDefinition(
  definition: TransformDefinition,
): TransformIssue[] {
  const config = definition.configuration;
  const issues: TransformIssue[] = [];
  if (config.operation === "replace_text") {
    if (config.pattern.length === 0) {
      issues.push({
        code: "invalid_configuration",
        path: "/configuration/pattern",
        message: "replacement pattern cannot be empty.",
      });
    } else if (config.mode === "regex") {
      if (!isSupportedRegex(config.pattern)) {
        issues.push({
          code: "invalid_configuration",
          path: "/configuration/pattern",
          message: "pattern must use supported RE2 syntax.",
        });
      }
    }
  }
  if (config.operation === "parse_json" && config.expectedSchema) {
    const parsed = parseJsonSchema202012(config.expectedSchema.source, {
      requireClosedObjects: true,
    });
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        issues.push({
          code: "invalid_configuration",
          path: `/configuration/expectedSchema/source${issue.path}`,
          message: issue.message,
        });
      }
    }
  }
  if (config.operation === "build_object") {
    if (config.fields.length === 0) {
      issues.push({
        code: "invalid_configuration",
        path: "/configuration/fields",
        message: "at least one output field is required.",
      });
    }
    if (config.fields.length > MAX_FIELDS) {
      issues.push({
        code: "invalid_configuration",
        path: "/configuration/fields",
        message: `at most ${MAX_FIELDS} output fields are supported.`,
      });
    }
    const names = new Set<string>();
    for (const [index, field] of config.fields.entries()) {
      const path = pointer("/configuration/fields", index);
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) ||
        !isWorkflowAddressablePathSegment(field.name) ||
        UNSAFE_FIELDS.has(field.name)
      ) {
        issues.push({
          code: "unsafe_output_field",
          path: pointer(path, "name"),
          message: `"${field.name}" is not a safe output field name.`,
        });
      } else if (names.has(field.name)) {
        issues.push({
          code: "unsafe_output_field",
          path: pointer(path, "name"),
          message: `output field "${field.name}" is duplicated.`,
        });
      }
      names.add(field.name);
    }
  }
  return issues;
}

export function deriveTransformOutputSchema(
  definition: TransformDefinition,
): JsonSchema202012 | null {
  if (validateTransformDefinition(definition).length > 0) return null;
  const config = definition.configuration;
  if (
    config.operation === "format_text" ||
    config.operation === "trim_text" ||
    config.operation === "replace_text" ||
    config.operation === "number_to_text"
  ) {
    return { $schema: JSON_SCHEMA_DIALECT, type: "string" };
  }
  if (config.operation === "text_to_number") {
    return {
      $schema: JSON_SCHEMA_DIALECT,
      type: "object",
      properties: {
        success: { type: "boolean" },
        value: { type: ["number", "null"] },
        error: { type: ["string", "null"] },
      },
      required: ["success", "value", "error"],
      additionalProperties: false,
    };
  }
  if (config.operation === "parse_json") {
    let valueSchema: JsonSchema202012 = {};
    if (config.expectedSchema) {
      const parsed = parseJsonSchema202012(config.expectedSchema.source, {
        requireClosedObjects: true,
      });
      if (!parsed.ok) return null;
      valueSchema = parsed.schema;
    }
    return {
      $schema: JSON_SCHEMA_DIALECT,
      type: "object",
      properties: {
        success: { type: "boolean" },
        value: { ...valueSchema, type: valueSchema.type ?? ["object", "array", "string", "number", "boolean", "null"] },
        error: { type: ["string", "null"] },
      },
      required: ["success", "value", "error"],
      additionalProperties: false,
    };
  }
  const properties: Record<string, JsonSchema202012> = {};
  const required: string[] = [];
  for (const field of config.fields) {
    const referenced =
      field.value.kind === "reference"
        ? definition.referenceSchemas?.[field.value.reference]
        : undefined;
    properties[field.name] =
      field.value.kind === "literal"
        ? scalarSchema(field.value.value)
        : field.value.defaultValue !== undefined
          ? referenced?.schema ?? scalarSchema(field.value.defaultValue)
          : referenced?.schema ?? {};
    if (
      field.value.kind === "literal" ||
      field.value.defaultValue !== undefined ||
      referenced?.required
    ) {
      required.push(field.name);
    }
  }
  return {
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function requireString(value: unknown, operation: string): string {
  if (typeof value !== "string") {
    throw new TransformExecutionError(`${operation} requires a text value.`);
  }
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TransformExecutionError("Number to text requires a finite number.");
  }
  return value;
}

function plainReplaceAll(
  source: string,
  pattern: string,
  replacement: string,
  ignoreCase: boolean,
): string {
  if (!ignoreCase) return source.split(pattern).join(replacement);
  const lowerSource = source.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  let result = "";
  let cursor = 0;
  for (;;) {
    const index = lowerSource.indexOf(lowerPattern, cursor);
    if (index < 0) return result + source.slice(cursor);
    result += source.slice(cursor, index) + replacement;
    cursor = index + pattern.length;
  }
}

function jsonSyntaxError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const position = /\bposition\s+(\d+)\b/i.exec(message)?.[1];
  return position
    ? `Input is not valid JSON near character ${position}.`
    : "Input is not valid JSON.";
}

export function executeTransform(
  configuration: TransformConfiguration,
  context: V2BindingResolutionContext,
): JsonValue | Promise<JsonValue> {
  if (configuration.operation === "format_text") {
    return resolveWorkflowPromptDataTokensV2(configuration.template, context);
  }
  if (configuration.operation === "build_object") {
    const output: Record<string, JsonValue> = {};
    for (const field of configuration.fields) {
      if (field.value.kind === "literal") {
        output[field.name] = field.value.value;
        continue;
      }
      let resolved: unknown;
      let missing = false;
      try {
        resolved = resolveWorkflowDataReferenceV2(field.value.reference, context);
      } catch {
        missing = true;
      }
      if ((missing || resolved === null) && field.value.defaultValue !== undefined) {
        output[field.name] = field.value.defaultValue;
      } else if (!missing) {
        output[field.name] = resolved as JsonValue;
      }
    }
    return output;
  }
  const source = resolveWorkflowDataReferenceV2(configuration.source, context);
  if (configuration.operation === "trim_text") {
    return requireString(source, "Trim text").trim();
  }
  if (configuration.operation === "replace_text") {
    const text = requireString(source, "Replace text");
    if (configuration.mode === "plain") {
      return plainReplaceAll(
        text,
        configuration.pattern,
        configuration.replacement,
        configuration.ignoreCase,
      );
    }
    return replaceTextRegexStep(
      text,
      configuration.pattern,
      configuration.replacement,
      configuration.ignoreCase,
    );
  }
  if (configuration.operation === "number_to_text") {
    return String(requireNumber(source));
  }
  const text = requireString(
    source,
    configuration.operation === "parse_json" ? "Parse JSON" : "Text to number",
  ).trim();
  if (configuration.operation === "text_to_number") {
    if (!JSON_NUMBER_PATTERN.test(text)) {
      return {
        success: false,
        value: null,
        error: "Input is not a valid number.",
      };
    }
    const value = Number(text);
    return Number.isFinite(value)
      ? { success: true, value, error: null }
      : { success: false, value: null, error: "Input is not a valid number." };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { success: false, value: null, error: jsonSyntaxError(error) };
  }
  if (configuration.expectedSchema) {
    const parsed = parseJsonSchema202012(configuration.expectedSchema.source, {
      requireClosedObjects: true,
    });
    if (!parsed.ok) {
      throw new TransformExecutionError("Parse JSON expected schema is invalid.");
    }
    const [issue] = validateJsonSchemaValue(parsed.schema, value);
    if (issue) {
      return {
        success: false,
        value: null,
        error: `${issue.path || "/"} ${issue.message.replace(/^output(?:\.[^ ]+)?\s*/, "")}`.trim(),
      };
    }
  }
  return { success: true, value: value as JsonValue, error: null };
}
