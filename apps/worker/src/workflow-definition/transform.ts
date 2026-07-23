import {
  isWorkflowAddressablePathSegment,
  type JsonSchema202012,
  type JsonValue,
  type TransformConfiguration,
  type TransformInputPath,
  type TransformPredicate,
} from "@shared/contracts";
import {
  inspectJsonSchema202012,
  validateJsonSchemaValue,
} from "./json-schema.js";

const MAX_FIELDS = 100;
const MAX_PREDICATE_DEPTH = 16;
const MAX_PREDICATE_NODES = 100;
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const ABSENT = Symbol("absent");

export interface TransformIssue {
  code:
    | "invalid_configuration"
    | "unknown_input"
    | "invalid_path"
    | "incompatible_value"
    | "unsafe_output_field";
  path: string;
  message: string;
}

export interface TransformDefinition {
  configuration: TransformConfiguration;
  inputSchemas: Record<string, JsonSchema202012>;
}

export class TransformExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformExecutionError";
  }
}

interface ResolvedSchema {
  schema: JsonSchema202012;
  guaranteed: boolean;
}

function schemaType(schema: JsonSchema202012): string | null {
  const raw = schema.type;
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return null;
  const nonNull = raw.filter((value) => value !== "null");
  return nonNull.length === 1 && typeof nonNull[0] === "string" ? nonNull[0] : null;
}

function schemaAllowsNull(schema: JsonSchema202012): boolean {
  const typeAllowsNull =
    schema.type === "null" ||
    (Array.isArray(schema.type) && schema.type.includes("null"));
  return (
    typeAllowsNull &&
    (!Array.isArray(schema.enum) || schema.enum.some((value) => value === null))
  );
}

function pointer(path: string, segment: string | number): string {
  return `${path}/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function inputSchemaAtPath(
  source: TransformInputPath,
  inputSchemas: Record<string, JsonSchema202012>,
  issuePath: string,
  issues: TransformIssue[],
): ResolvedSchema | null {
  let current = inputSchemas[source.input];
  if (!current) {
    issues.push({
      code: "unknown_input",
      path: pointer(issuePath, "input"),
      message: `Transform input "${source.input}" is not declared.`,
    });
    return null;
  }

  let guaranteed = true;
  for (const [index, segment] of source.path.entries()) {
    if (!isWorkflowAddressablePathSegment(segment)) {
      issues.push({
        code: "invalid_path",
        path: pointer(pointer(issuePath, "path"), index),
        message: `Transform path segment "${segment}" is not addressable.`,
      });
      return null;
    }
    // A required child of a nullable object is guaranteed only when that
    // object exists. Keep the path addressable for Map, but do not advertise
    // the selected value as always present.
    guaranteed = guaranteed && !schemaAllowsNull(current);
    if (schemaType(current) !== "object") {
      issues.push({
        code: "invalid_path",
        path: pointer(pointer(issuePath, "path"), index),
        message: `Transform path "${source.path.slice(0, index + 1).join(".")}" does not select an object field.`,
      });
      return null;
    }
    const properties = current.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      issues.push({
        code: "invalid_path",
        path: pointer(pointer(issuePath, "path"), index),
        message: `Transform path "${source.path.slice(0, index + 1).join(".")}" is not declared.`,
      });
      return null;
    }
    const child = properties[segment];
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      issues.push({
        code: "invalid_path",
        path: pointer(pointer(issuePath, "path"), index),
        message: `Transform path "${source.path.slice(0, index + 1).join(".")}" is not declared.`,
      });
      return null;
    }
    guaranteed =
      guaranteed &&
      Array.isArray(current.required) &&
      current.required.includes(segment);
    current = child as JsonSchema202012;
  }
  return { schema: current, guaranteed };
}

function itemSchemaAtPath(
  itemSchema: JsonSchema202012,
  path: string[],
  issuePath: string,
  issues: TransformIssue[],
): JsonSchema202012 | null {
  return inputSchemaAtPath(
    { input: "item", path },
    { item: itemSchema },
    issuePath,
    issues,
  )?.schema ?? null;
}

function compatibleValue(
  schema: JsonSchema202012,
  value: JsonValue,
  path: string,
  label: string,
  issues: TransformIssue[],
): boolean {
  let valueIssues;
  try {
    valueIssues = validateJsonSchemaValue(schema, value);
  } catch {
    issues.push({
      code: "invalid_configuration",
      path,
      message: `${label} cannot be checked because its field schema is invalid.`,
    });
    return false;
  }
  if (valueIssues.length === 0) return true;
  issues.push({
    code: "incompatible_value",
    path,
    message: `${label} is incompatible with the selected field type.`,
  });
  return false;
}

function validatePredicate(
  predicate: TransformPredicate,
  itemSchema: JsonSchema202012,
  path: string,
  depth: number,
  budget: { nodes: number },
  issues: TransformIssue[],
): void {
  budget.nodes += 1;
  if (depth > MAX_PREDICATE_DEPTH || budget.nodes > MAX_PREDICATE_NODES) {
    issues.push({
      code: "invalid_configuration",
      path,
      message: "Transform predicate is too complex.",
    });
    return;
  }

  if (predicate.kind === "all" || predicate.kind === "any") {
    if (predicate.predicates.length === 0) {
      issues.push({
        code: "invalid_configuration",
        path: pointer(path, "predicates"),
        message: `${predicate.kind} requires at least one predicate.`,
      });
      return;
    }
    predicate.predicates.forEach((child, index) =>
      validatePredicate(
        child,
        itemSchema,
        pointer(pointer(path, "predicates"), index),
        depth + 1,
        budget,
        issues,
      ),
    );
    return;
  }

  if (predicate.kind === "not") {
    validatePredicate(
      predicate.predicate,
      itemSchema,
      pointer(path, "predicate"),
      depth + 1,
      budget,
      issues,
    );
    return;
  }

  const fieldSchema = itemSchemaAtPath(itemSchema, predicate.path, path, issues);
  if (!fieldSchema || predicate.kind === "is_null") return;
  const type = schemaType(fieldSchema);
  const operatorPath = pointer(path, "operator");

  if (
    (predicate.operator === "greater_than" ||
      predicate.operator === "greater_than_or_equal" ||
      predicate.operator === "less_than" ||
      predicate.operator === "less_than_or_equal") &&
    type !== "number"
  ) {
    issues.push({
      code: "invalid_configuration",
      path: operatorPath,
      message: `Operator "${predicate.operator}" requires a number field.`,
    });
    return;
  }
  if (predicate.operator === "contains" && type !== "string") {
    issues.push({
      code: "invalid_configuration",
      path: operatorPath,
      message: 'Operator "contains" requires a string field.',
    });
    return;
  }
  if (
    predicate.operator === "not_equals" &&
    type !== "string" &&
    !Array.isArray(fieldSchema.enum)
  ) {
    issues.push({
      code: "invalid_configuration",
      path: operatorPath,
      message: 'Operator "not_equals" requires a string or enum field.',
    });
    return;
  }
  if (!["string", "number", "boolean"].includes(type ?? "")) {
    issues.push({
      code: "invalid_configuration",
      path: operatorPath,
      message: `Operator "${predicate.operator}" does not support this field type.`,
    });
    return;
  }
  compatibleValue(
    fieldSchema,
    predicate.value,
    pointer(path, "value"),
    "Predicate value",
    issues,
  );
}

export function validateTransformDefinition(definition: TransformDefinition): TransformIssue[] {
  const issues: TransformIssue[] = [];
  for (const [name, schema] of Object.entries(definition.inputSchemas)) {
    const inspected = inspectJsonSchema202012(schema, { requireClosedObjects: true });
    if (!inspected.ok) {
      issues.push({
        code: "invalid_configuration",
        path: pointer("/inputSchemas", name),
        message: `Transform input "${name}" does not have a deployable schema.`,
      });
    }
  }

  const config = definition.configuration;
  if (config.operation === "map_object") {
    if (config.fields.length === 0 || config.fields.length > MAX_FIELDS) {
      issues.push({
        code: "invalid_configuration",
        path: "/configuration/fields",
        message: `Map object requires between 1 and ${MAX_FIELDS} fields.`,
      });
    }
    const names = new Set<string>();
    config.fields.forEach((field, index) => {
      const fieldPath = pointer("/configuration/fields", index);
      if (!isWorkflowAddressablePathSegment(field.name)) {
        issues.push({
          code: "unsafe_output_field",
          path: pointer(fieldPath, "name"),
          message: `Output field "${field.name}" is not addressable.`,
        });
      } else if (names.has(field.name)) {
        issues.push({
          code: "unsafe_output_field",
          path: pointer(fieldPath, "name"),
          message: `Output field "${field.name}" is duplicated.`,
        });
      }
      names.add(field.name);

      if (field.value.kind === "literal") {
        const literalSchema = schemaForLiteral(field.value.value);
        const inspected = inspectJsonSchema202012(literalSchema, {
          requireClosedObjects: true,
        });
        if (
          !inspected.ok ||
          validateJsonSchemaValue(literalSchema, field.value.value).length > 0
        ) {
          issues.push({
            code: "incompatible_value",
            path: pointer(pointer(fieldPath, "value"), "value"),
            message:
              "Literal cannot be represented by the supported output schema types.",
          });
        }
        return;
      }
      const resolved = inputSchemaAtPath(
        field.value.source,
        definition.inputSchemas,
        pointer(pointer(fieldPath, "value"), "source"),
        issues,
      );
      if (resolved && field.value.defaultValue !== undefined) {
        compatibleValue(
          resolved.schema,
          field.value.defaultValue,
          pointer(pointer(fieldPath, "value"), "defaultValue"),
          "Default value",
          issues,
        );
      }
    });
    return issues;
  }

  const source = inputSchemaAtPath(
    config.source,
    definition.inputSchemas,
    "/configuration/source",
    issues,
  );
  if (!source) return issues;
  if (schemaType(source.schema) !== "array") {
    issues.push({
      code: "invalid_configuration",
      path: "/configuration/source",
      message: "Filter array source must select an array.",
    });
    return issues;
  }
  if (!source.guaranteed || schemaAllowsNull(source.schema)) {
    issues.push({
      code: "invalid_configuration",
      path: "/configuration/source",
      message: "Filter array source must be guaranteed and non-null.",
    });
    return issues;
  }
  const items = source.schema.items;
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    issues.push({
      code: "invalid_configuration",
      path: "/configuration/source",
      message: "Filter array source must declare an item schema.",
    });
    return issues;
  }
  validatePredicate(
    config.predicate,
    items as JsonSchema202012,
    "/configuration/predicate",
    0,
    { nodes: 0 },
    issues,
  );
  return issues;
}

function schemaForLiteral(value: JsonValue): JsonSchema202012 {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      type: "array",
      items: first === undefined ? { type: "null" } : schemaForLiteral(first),
    };
  }
  if (typeof value === "object") {
    const properties = Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, schemaForLiteral(child)]),
    );
    return {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  return { type: typeof value };
}

export function deriveTransformOutputSchema(
  definition: TransformDefinition,
): JsonSchema202012 | null {
  if (validateTransformDefinition(definition).length > 0) return null;
  const config = definition.configuration;
  if (config.operation === "filter_array") {
    return inputSchemaAtPath(
      config.source,
      definition.inputSchemas,
      "",
      [],
    )!.schema;
  }

  const properties: Record<string, JsonSchema202012> = {};
  const required: string[] = [];
  for (const field of config.fields) {
    if (field.value.kind === "literal") {
      properties[field.name] = schemaForLiteral(field.value.value);
      required.push(field.name);
      continue;
    }
    const resolved = inputSchemaAtPath(
      field.value.source,
      definition.inputSchemas,
      "",
      [],
    )!;
    properties[field.name] = resolved.schema;
    if (resolved.guaranteed || field.value.defaultValue !== undefined) {
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

function valueAtPath(value: JsonValue, path: string[]): JsonValue | typeof ABSENT {
  let current: JsonValue | typeof ABSENT = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return ABSENT;
    }
    current = current[segment];
  }
  return current;
}

function inputValueAtPath(
  inputs: Record<string, JsonValue>,
  source: TransformInputPath,
): JsonValue | typeof ABSENT {
  const input = Object.prototype.hasOwnProperty.call(inputs, source.input)
    ? inputs[source.input]
    : ABSENT;
  return input === ABSENT ? ABSENT : valueAtPath(input, source.path);
}

type PredicateResult = boolean | typeof ABSENT;

function matchesPredicate(
  item: JsonValue,
  predicate: TransformPredicate,
): PredicateResult {
  if (predicate.kind === "all") {
    let missing = false;
    for (const child of predicate.predicates) {
      const result = matchesPredicate(item, child);
      if (result === false) return false;
      if (result === ABSENT) missing = true;
    }
    return missing ? ABSENT : true;
  }
  if (predicate.kind === "any") {
    let missing = false;
    for (const child of predicate.predicates) {
      const result = matchesPredicate(item, child);
      if (result === true) return true;
      if (result === ABSENT) missing = true;
    }
    return missing ? ABSENT : false;
  }
  if (predicate.kind === "not") {
    const result = matchesPredicate(item, predicate.predicate);
    return result === ABSENT ? ABSENT : !result;
  }

  const actual = valueAtPath(item, predicate.path);
  if (actual === ABSENT) return ABSENT;
  if (predicate.kind === "is_null") {
    return predicate.isNull ? actual === null : actual !== null;
  }
  switch (predicate.operator) {
    case "equals":
      return actual === predicate.value;
    case "not_equals":
      return actual !== predicate.value;
    case "contains":
      return typeof actual === "string" && actual.includes(String(predicate.value));
    case "greater_than":
      return typeof actual === "number" && actual > Number(predicate.value);
    case "greater_than_or_equal":
      return typeof actual === "number" && actual >= Number(predicate.value);
    case "less_than":
      return typeof actual === "number" && actual < Number(predicate.value);
    case "less_than_or_equal":
      return typeof actual === "number" && actual <= Number(predicate.value);
  }
}

export function executeTransform(
  configuration: TransformConfiguration,
  inputs: Record<string, JsonValue>,
): JsonValue {
  if (configuration.operation === "map_object") {
    const output: Record<string, JsonValue> = {};
    for (const field of configuration.fields) {
      if (field.value.kind === "literal") {
        output[field.name] = field.value.value;
        continue;
      }
      const value = inputValueAtPath(inputs, field.value.source);
      if (value !== ABSENT) {
        output[field.name] = value;
      } else if (field.value.defaultValue !== undefined) {
        output[field.name] = field.value.defaultValue;
      }
    }
    return output;
  }

  const source = inputValueAtPath(inputs, configuration.source);
  if (!Array.isArray(source)) {
    throw new TransformExecutionError("Transform Filter array source is not an array.");
  }
  return source.filter(
    (item): item is JsonValue =>
      matchesPredicate(item, configuration.predicate) === true,
  );
}
