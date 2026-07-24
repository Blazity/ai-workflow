import type {
  JsonSchema202012,
  JsonValue,
  WorkflowDataCatalogEntry,
  WorkflowBranchBooleanAstV2,
  WorkflowBranchConfigurationV2,
  WorkflowBranchOperandV2,
  WorkflowDataReferenceV2,
} from "@shared/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isOperand(value: unknown): value is WorkflowBranchOperandV2 {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "path") {
    return hasExactKeys(value, ["kind", "reference"]) && typeof value.reference === "string";
  }
  return (
    value.kind === "lit" &&
    hasExactKeys(value, ["kind", "value"]) &&
    isScalar(value.value)
  );
}

export function isWorkflowBranchBooleanAstV2(
  value: unknown,
  depth = 0,
): value is WorkflowBranchBooleanAstV2 {
  if (depth > 20 || !isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "lit") {
    return (
      hasExactKeys(value, ["kind", "value"]) &&
      typeof value.value === "boolean"
    );
  }
  if (value.kind === "path") return isOperand(value);
  if (value.kind === "not") {
    return (
      hasExactKeys(value, ["kind", "operand"]) &&
      isWorkflowBranchBooleanAstV2(value.operand, depth + 1)
    );
  }
  if (value.kind === "and" || value.kind === "or") {
    return (
      hasExactKeys(value, ["kind", "left", "right"]) &&
      isWorkflowBranchBooleanAstV2(value.left, depth + 1) &&
      isWorkflowBranchBooleanAstV2(value.right, depth + 1)
    );
  }
  if (value.kind === "eq" || value.kind === "neq") {
    return (
      hasExactKeys(value, ["kind", "left", "right"]) &&
      isOperand(value.left) &&
      isOperand(value.right)
    );
  }
  return false;
}

export function parseWorkflowBranchConfigurationV2(
  configuration: Readonly<Record<string, JsonValue>>,
): WorkflowBranchConfigurationV2 | null {
  if (
    !hasExactKeys(configuration, ["condition"]) ||
    !isWorkflowBranchBooleanAstV2(configuration.condition)
  ) {
    return null;
  }
  return { condition: configuration.condition };
}

function schemaTypes(schema: JsonSchema202012): string[] {
  return Array.isArray(schema.type)
    ? schema.type.filter((value): value is string => typeof value === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
}

export function isBooleanWorkflowValue(value: WorkflowDataCatalogEntry): boolean {
  return schemaTypes(value.schema).includes("boolean");
}

export function branchLiteralForSchema(
  schema: JsonSchema202012 | undefined,
): string | number | boolean | null {
  const enumValue = Array.isArray(schema?.enum)
    ? schema.enum.find(isScalar)
    : undefined;
  if (enumValue !== undefined) return enumValue;
  const types = schema ? schemaTypes(schema) : [];
  if (types.includes("string")) return "";
  if (types.includes("number") || types.includes("integer")) return 0;
  if (types.includes("boolean")) return false;
  if (types.includes("null")) return null;
  return "";
}

export function branchSchemaForOperand(
  operand: WorkflowBranchOperandV2,
  availableValues: readonly WorkflowDataCatalogEntry[],
): JsonSchema202012 | undefined {
  if (operand.kind !== "path") return undefined;
  return availableValues.find((value) => value.reference === operand.reference)?.schema;
}

function firstPath(
  availableValues: readonly WorkflowDataCatalogEntry[],
  booleanOnly = false,
): WorkflowDataReferenceV2 | null {
  return (
    availableValues.find(
      (value) =>
        value.availability.state === "available" &&
        (!booleanOnly || isBooleanWorkflowValue(value)),
    )
      ?.reference ?? null
  );
}

function defaultOperandPair(
  availableValues: readonly WorkflowDataCatalogEntry[],
): [WorkflowBranchOperandV2, WorkflowBranchOperandV2] {
  const reference = firstPath(availableValues);
  if (!reference) {
    return [
      { kind: "lit", value: false },
      { kind: "lit", value: true },
    ];
  }
  const schema = availableValues.find((value) => value.reference === reference)?.schema;
  return [
    { kind: "path", reference },
    { kind: "lit", value: branchLiteralForSchema(schema) },
  ];
}

export function defaultWorkflowBranchCondition(
  availableValues: readonly WorkflowDataCatalogEntry[],
): WorkflowBranchBooleanAstV2 {
  const reference = firstPath(availableValues, true);
  return reference
    ? { kind: "path", reference }
    : { kind: "lit", value: false };
}

export function branchConditionForKind(
  kind: WorkflowBranchBooleanAstV2["kind"],
  availableValues: readonly WorkflowDataCatalogEntry[],
): WorkflowBranchBooleanAstV2 {
  const base = defaultWorkflowBranchCondition(availableValues);
  switch (kind) {
    case "lit":
      return { kind: "lit", value: false };
    case "path":
      return base;
    case "not":
      return { kind: "not", operand: base };
    case "and":
    case "or":
      return { kind, left: base, right: base };
    case "eq":
    case "neq": {
      const [left, right] = defaultOperandPair(availableValues);
      return { kind, left, right };
    }
  }
}

function valueLabel(
  reference: WorkflowDataReferenceV2,
  availableValues: readonly WorkflowDataCatalogEntry[],
): string {
  const catalogLabel = availableValues.find(
    (value) => value.reference === reference,
  )?.label;
  if (catalogLabel) return catalogLabel;
  const segments = reference.split(".");
  if (segments[0] === "steps" && segments[2] === "output") {
    return `${segments[1]} · ${segments.slice(3).join(".")}`;
  }
  if (segments[0] === "run") return `Run · ${segments.slice(1).join(".")}`;
  return "Unavailable workflow value";
}

function operandSummary(
  operand: WorkflowBranchOperandV2,
  availableValues: readonly WorkflowDataCatalogEntry[],
): string {
  return operand.kind === "path"
    ? valueLabel(operand.reference, availableValues)
    : JSON.stringify(operand.value);
}

export function summarizeWorkflowBranchCondition(
  condition: WorkflowBranchBooleanAstV2,
  availableValues: readonly WorkflowDataCatalogEntry[] = [],
): string {
  switch (condition.kind) {
    case "lit":
      return condition.value ? "Always true" : "Always false";
    case "path":
      return valueLabel(condition.reference, availableValues);
    case "not":
      return `Not (${summarizeWorkflowBranchCondition(condition.operand, availableValues)})`;
    case "and":
      return `${summarizeWorkflowBranchCondition(condition.left, availableValues)} and ${summarizeWorkflowBranchCondition(condition.right, availableValues)}`;
    case "or":
      return `${summarizeWorkflowBranchCondition(condition.left, availableValues)} or ${summarizeWorkflowBranchCondition(condition.right, availableValues)}`;
    case "eq":
      return `${operandSummary(condition.left, availableValues)} equals ${operandSummary(condition.right, availableValues)}`;
    case "neq":
      return `${operandSummary(condition.left, availableValues)} does not equal ${operandSummary(condition.right, availableValues)}`;
  }
}
