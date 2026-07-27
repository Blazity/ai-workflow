import type { WorkflowDataCatalogEntry } from "./api.js";
import type { JsonSchema202012 } from "./domain.js";

export type WorkflowValueCompatibilityReasonCode =
  | "graph_unavailable"
  | "presence_optional"
  | "nullable"
  | "type_mismatch"
  | "unsupported_destination";

export interface WorkflowValueCompatibility {
  compatible: boolean;
  reason?: {
    code: WorkflowValueCompatibilityReasonCode;
    message: string;
  };
}

export type WorkflowValueDestination =
  | { kind: "mixed_text" }
  | { kind: "typed_input"; inputName: string }
  | { kind: "typed_list_item"; inputName: string }
  | { kind: "branch"; allowMissing?: boolean }
  | { kind: "transform_text" }
  | { kind: "transform_number" }
  | { kind: "build_object" };

function schemaTypes(schema: JsonSchema202012): Set<string> {
  const raw = Array.isArray(schema.type) ? schema.type : [schema.type];
  const types = new Set(raw.filter((type): type is string => typeof type === "string"));
  if (
    types.size === 0 &&
    Array.isArray(schema.enum) &&
    schema.enum.length > 0
  ) {
    for (const value of schema.enum) {
      if (value === null) types.add("null");
      else if (typeof value === "number") types.add("number");
      else if (typeof value === "string") types.add("string");
      else if (typeof value === "boolean") types.add("boolean");
    }
  }
  return types;
}

function incompatible(
  code: WorkflowValueCompatibilityReasonCode,
  message: string,
): WorkflowValueCompatibility {
  return { compatible: false, reason: { code, message } };
}

export function evaluateWorkflowValueCompatibility(
  entry: WorkflowDataCatalogEntry,
  destination: WorkflowValueDestination,
): WorkflowValueCompatibility {
  if (entry.availability.state === "unavailable") {
    return incompatible("graph_unavailable", entry.availability.reason);
  }

  if (destination.kind === "build_object") return { compatible: true };
  const types = schemaTypes(entry.schema);
  if (destination.kind === "branch" && destination.allowMissing) {
    const scalar = [...types].every((type) =>
      ["string", "number", "integer", "boolean", "null"].includes(type),
    );
    return scalar && types.size > 0
      ? { compatible: true }
      : incompatible(
          "unsupported_destination",
          "Branch conditions require a text, number, boolean, or null value.",
        );
  }

  if (
    entry.presence === "optional" ||
    entry.presence === "optional_nullable"
  ) {
    return incompatible(
      "presence_optional",
      "This value is not present on every path that reaches this block.",
    );
  }
  if (entry.presence === "nullable") {
    return incompatible(
      "nullable",
      "This value can be null when the block runs.",
    );
  }

  if (destination.kind === "typed_input") {
    return entry.compatibleInputNames.includes(destination.inputName)
      ? { compatible: true }
      : incompatible(
          "type_mismatch",
          "This value has a different type than the selected input.",
        );
  }
  if (destination.kind === "typed_list_item") {
    return entry.compatibleListInputNames?.includes(destination.inputName)
      ? { compatible: true }
      : incompatible(
          "type_mismatch",
          "This value has a different type than the selected list item.",
        );
  }

  if (destination.kind === "mixed_text") {
    return types.has("string") ||
      types.has("number") ||
      types.has("integer")
      ? { compatible: true }
      : incompatible(
          "type_mismatch",
          "Only text and number values can be inserted into text.",
        );
  }
  if (destination.kind === "transform_text") {
    return types.has("string")
      ? { compatible: true }
      : incompatible("type_mismatch", "This operation requires a text value.");
  }
  if (destination.kind === "transform_number") {
    return types.has("number") || types.has("integer")
      ? { compatible: true }
      : incompatible("type_mismatch", "This operation requires a number value.");
  }
  if (destination.kind === "branch") {
    const scalar = [...types].every((type) =>
      ["string", "number", "integer", "boolean"].includes(type),
    );
    return scalar && types.size > 0
      ? { compatible: true }
      : incompatible(
          "unsupported_destination",
          "Branch comparisons require a text, number, or boolean value.",
        );
  }
  return incompatible(
    "unsupported_destination",
    "This value cannot be used here.",
  );
}
