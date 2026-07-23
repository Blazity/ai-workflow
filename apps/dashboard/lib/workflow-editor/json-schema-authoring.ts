import {
  isWorkflowAddressablePathSegment,
  type JsonSchema202012,
  type JsonValue,
} from "@shared/contracts";

export type VisualJsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";

export const DEFAULT_VISUAL_JSON_SCHEMA: JsonSchema202012 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

export interface SourceBoundValue<T> {
  source: string;
  value: T;
}

/**
 * Async inspection results may arrive after the editor has moved to another
 * node or source. Only an exact source match is safe to render or edit.
 */
export function valueForExactSchemaSource<T>(
  source: string,
  snapshot: SourceBoundValue<T> | null,
): T | null {
  return snapshot?.source === source ? snapshot.value : null;
}

const visualTypes = new Set<VisualJsonSchemaType>([
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
]);

export function visualSchemaType(
  schema: JsonSchema202012,
): VisualJsonSchemaType | null {
  const rawType = schema.type;
  const type = Array.isArray(rawType)
    ? rawType.find((candidate) => candidate !== "null")
    : rawType;
  return typeof type === "string" && visualTypes.has(type as VisualJsonSchemaType)
    ? (type as VisualJsonSchemaType)
    : null;
}

export function visualSchemaNullable(schema: JsonSchema202012): boolean {
  return Array.isArray(schema.type) && schema.type.includes("null");
}

export function changeVisualSchemaType(
  schema: JsonSchema202012,
  nextType: VisualJsonSchemaType,
): JsonSchema202012 {
  const next: JsonSchema202012 = {};
  if (typeof schema.$schema === "string") next.$schema = schema.$schema;
  if (typeof schema.description === "string") next.description = schema.description;
  next.type =
    nextType !== "null" && visualSchemaNullable(schema)
      ? [nextType, "null"]
      : nextType;

  if (nextType === "object") {
    next.properties =
      visualSchemaType(schema) === "object" &&
      schema.properties !== null &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {};
    const propertyNames = new Set(Object.keys(next.properties as object));
    next.required = Array.isArray(schema.required)
      ? schema.required.filter(
          (name): name is string =>
            typeof name === "string" && propertyNames.has(name),
        )
      : [];
    next.additionalProperties =
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : false;
  } else if (nextType === "array") {
    next.items =
      visualSchemaType(schema) === "array" &&
      schema.items !== null &&
      typeof schema.items === "object" &&
      !Array.isArray(schema.items)
        ? schema.items
        : { type: "string" };
  }
  return next;
}

export function setVisualSchemaNullable(
  schema: JsonSchema202012,
  nullable: boolean,
): JsonSchema202012 {
  const type = visualSchemaType(schema);
  if (type === null || type === "null") return schema;
  const enumValues = Array.isArray(schema.enum)
    ? (schema.enum as JsonValue[])
    : null;
  const next: JsonSchema202012 = {
    ...schema,
    type: nullable ? [type, "null"] : type,
  };
  if (enumValues !== null) {
    const nextEnum = nullable
      ? enumValues.includes(null)
        ? enumValues
        : [...enumValues, null]
      : enumValues.filter((value) => value !== null);
    if (nextEnum.length > 0) next.enum = nextEnum;
    else delete next.enum;
  }
  return next;
}

export function setVisualSchemaDescription(
  schema: JsonSchema202012,
  description: string,
): JsonSchema202012 {
  const next = { ...schema };
  if (description.trim().length === 0) delete next.description;
  else next.description = description;
  return next;
}

export function setVisualSchemaEnum(
  schema: JsonSchema202012,
  values: JsonValue[] | null,
): JsonSchema202012 {
  const next = { ...schema };
  if (values === null || values.length === 0) delete next.enum;
  else next.enum = values;
  return next;
}

function propertiesOf(
  schema: JsonSchema202012,
): Record<string, JsonSchema202012> {
  const raw = schema.properties;
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, JsonSchema202012>)
    : {};
}

function requiredOf(schema: JsonSchema202012): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
}

export function addVisualSchemaProperty(
  schema: JsonSchema202012,
  name: string,
): JsonSchema202012 | null {
  if (!isWorkflowAddressablePathSegment(name)) return null;
  const properties = propertiesOf(schema);
  if (Object.hasOwn(properties, name)) return null;
  return {
    ...schema,
    properties: { ...properties, [name]: { type: "string" } },
  };
}

export function removeVisualSchemaProperty(
  schema: JsonSchema202012,
  name: string,
): JsonSchema202012 {
  const properties = { ...propertiesOf(schema) };
  delete properties[name];
  return {
    ...schema,
    properties,
    required: requiredOf(schema).filter((candidate) => candidate !== name),
  };
}

export function renameVisualSchemaProperty(
  schema: JsonSchema202012,
  currentName: string,
  nextName: string,
): JsonSchema202012 | null {
  if (!isWorkflowAddressablePathSegment(nextName)) return null;
  const properties = propertiesOf(schema);
  if (
    !Object.hasOwn(properties, currentName) ||
    (currentName !== nextName && Object.hasOwn(properties, nextName))
  ) {
    return null;
  }
  const renamed: Record<string, JsonSchema202012> = {};
  for (const [name, child] of Object.entries(properties)) {
    renamed[name === currentName ? nextName : name] = child;
  }
  return {
    ...schema,
    properties: renamed,
    required: requiredOf(schema).map((name) =>
      name === currentName ? nextName : name,
    ),
  };
}

export function setVisualSchemaPropertyRequired(
  schema: JsonSchema202012,
  name: string,
  required: boolean,
): JsonSchema202012 {
  const names = new Set(requiredOf(schema));
  if (required) names.add(name);
  else names.delete(name);
  const propertyOrder = Object.keys(propertiesOf(schema));
  return {
    ...schema,
    required: propertyOrder.filter((property) => names.has(property)),
  };
}

export function setVisualSchemaProperty(
  schema: JsonSchema202012,
  name: string,
  child: JsonSchema202012,
): JsonSchema202012 {
  return {
    ...schema,
    properties: { ...propertiesOf(schema), [name]: child },
  };
}

export function setVisualSchemaArrayItems(
  schema: JsonSchema202012,
  items: JsonSchema202012,
): JsonSchema202012 {
  return { ...schema, items };
}

export function setVisualSchemaAdditionalProperties(
  schema: JsonSchema202012,
  allowed: boolean,
): JsonSchema202012 {
  return { ...schema, additionalProperties: allowed };
}
