import type {
  BlockOutput,
  JsonValue,
  WorkflowInputBindings,
  WorkflowValueSchema,
} from "@shared/contracts";
import { isSafeWorkflowInputName } from "@shared/contracts";
import type { StepsRecord } from "./interpreter.js";

export { isSafeWorkflowInputName } from "@shared/contracts";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export type ParsedWorkflowBindingSource =
  | { root: "trigger"; path: string[] }
  | { root: "steps"; nodeId: string; path: string[] }
  | { root: "run"; path: string[] };

export interface WorkflowRunBindingValues {
  id: string;
  branchName: string;
  defaultAgent: { provider: string; model: string };
}

export const RUN_BINDING_SCHEMA: WorkflowValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    branchName: { type: "string" },
    defaultAgent: {
      type: "object",
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
      },
      required: ["provider", "model"],
      additionalProperties: false,
    },
  },
  required: ["id", "branchName", "defaultAgent"],
  additionalProperties: false,
};

function safeSegments(source: string): string[] | null {
  if (source.trim() !== source) return null;
  const segments = source.split(".");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || /\s/.test(segment) || FORBIDDEN_SEGMENTS.has(segment),
    )
  ) {
    return null;
  }
  return segments;
}

export function parseWorkflowBindingSource(source: string): ParsedWorkflowBindingSource | null {
  const segments = safeSegments(source);
  if (!segments) return null;

  if (segments[0] === "trigger" && segments.length >= 2) {
    return { root: "trigger", path: segments.slice(1) };
  }
  if (segments[0] === "run" && segments.length >= 2) {
    return { root: "run", path: segments.slice(1) };
  }
  if (segments[0] === "steps" && segments.length >= 4 && segments[2] === "output") {
    return { root: "steps", nodeId: segments[1], path: segments.slice(3) };
  }
  return null;
}

export function resolveWorkflowSchemaPath(
  schema: WorkflowValueSchema,
  path: readonly string[],
): WorkflowValueSchema | null {
  let current = schema;
  for (const segment of path) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return null;
    if (current.type === "nullable") current = current.value;
    if (current.type === "object") {
      if (Object.prototype.hasOwnProperty.call(current.properties, segment)) {
        current = current.properties[segment];
        continue;
      }
      return current.additionalProperties ? { type: "unknown" } : null;
    }
    if (current.type === "array" && /^(?:0|[1-9]\d*)$/.test(segment)) {
      current = current.items;
      continue;
    }
    return null;
  }
  return current;
}

export function isWorkflowSchemaAssignable(
  source: WorkflowValueSchema,
  target: WorkflowValueSchema,
): boolean {
  if (target.type === "unknown") return true;
  if (source.type === "unknown") return false;

  // A schema with an enum denotes only those exact values. Checking those
  // values directly is both more precise and safer than comparing only the
  // surrounding structural type (for example, an object enum may be narrower
  // than its declared properties). Boolean and null schemas are finite too.
  const finiteSourceValues = finiteWorkflowSchemaValues(source);
  if (finiteSourceValues !== null) {
    return finiteSourceValues.every((value) =>
      workflowSchemaAcceptsValue(target, value),
    );
  }
  // A non-finite source can always produce a value outside a finite target
  // enum, so it cannot be assigned safely.
  if (target.enum !== undefined) return false;

  if (target.type === "nullable") {
    if (source.type === "null") return true;
    return source.type === "nullable"
      ? isWorkflowSchemaAssignable(source.value, target.value)
      : isWorkflowSchemaAssignable(source, target.value);
  }
  if (source.type === "nullable") return false;
  if (source.type !== target.type) return false;

  if (source.type === "array" && target.type === "array") {
    return isWorkflowSchemaAssignable(source.items, target.items);
  }
  if (source.type === "object" && target.type === "object") {
    for (const required of target.required) {
      const sourceChild = source.properties[required];
      const targetChild = target.properties[required];
      if (!sourceChild || !targetChild || !source.required.includes(required)) return false;
      if (!isWorkflowSchemaAssignable(sourceChild, targetChild)) return false;
    }
    for (const [key, targetChild] of Object.entries(target.properties)) {
      const sourceChild = source.properties[key];
      if (sourceChild) {
        if (!isWorkflowSchemaAssignable(sourceChild, targetChild)) return false;
      } else if (
        source.additionalProperties &&
        !isWorkflowSchemaAssignable({ type: "unknown" }, targetChild)
      ) {
        // An open source without a declaration for this key may emit any value
        // there, including values outside the target property's schema.
        return false;
      }
    }
    if (!target.additionalProperties) {
      if (source.additionalProperties) return false;
      for (const key of Object.keys(source.properties)) {
        if (!Object.prototype.hasOwnProperty.call(target.properties, key)) {
          // Even an optional source property may be present, while a closed
          // target rejects every undeclared key.
          return false;
        }
      }
    }
  }
  return true;
}

function finiteWorkflowSchemaValues(
  schema: WorkflowValueSchema,
): JsonValue[] | null {
  if (schema.enum !== undefined) {
    return schema.enum.filter((value) => workflowSchemaAcceptsValue(schema, value));
  }
  if (schema.type === "null") return [null];
  if (schema.type === "boolean") return [false, true];
  if (schema.type !== "nullable") return null;

  const inner = finiteWorkflowSchemaValues(schema.value);
  if (inner === null) return null;
  return dedupeJsonValues([...inner, null]);
}

function workflowSchemaAcceptsValue(
  schema: WorkflowValueSchema,
  value: JsonValue,
): boolean {
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))
  ) {
    return false;
  }

  switch (schema.type) {
    case "unknown":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "nullable":
      return value === null || workflowSchemaAcceptsValue(schema.value, value);
    case "array":
      return (
        Array.isArray(value) &&
        value.every((item) => workflowSchemaAcceptsValue(schema.items, item))
      );
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      for (const required of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, required)) return false;
      }
      for (const [key, child] of Object.entries(value)) {
        const childSchema = schema.properties[key];
        if (childSchema) {
          if (!workflowSchemaAcceptsValue(childSchema, child)) return false;
        } else if (!schema.additionalProperties) {
          return false;
        }
      }
      return true;
    }
  }
}

function dedupeJsonValues(values: JsonValue[]): JsonValue[] {
  return values.filter(
    (value, index) =>
      values.findIndex((candidate) => jsonValuesEqual(candidate, value)) ===
      index,
  );
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]!))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonValuesEqual(left[key]!, right[key]!),
    )
  );
}

function ownPathValue(root: unknown, path: readonly string[]): { found: boolean; value?: unknown } {
  let current = root;
  for (const segment of path) {
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

export function resolveWorkflowInputBindings(
  bindings: WorkflowInputBindings,
  triggerOutput: BlockOutput,
  steps: StepsRecord,
  runValues: WorkflowRunBindingValues | undefined,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(bindings)) {
    if (!isSafeWorkflowInputName(name)) {
      throw new Error(`input name "${name}" is not safe`);
    }
    const parsed = parseWorkflowBindingSource(source);
    let result: { found: boolean; value?: unknown } = { found: false };
    if (parsed?.root === "trigger") {
      result = ownPathValue(triggerOutput, parsed.path);
    } else if (parsed?.root === "run") {
      result = ownPathValue(runValues, parsed.path);
    } else if (parsed?.root === "steps") {
      const step = Object.prototype.hasOwnProperty.call(steps, parsed.nodeId)
        ? steps[parsed.nodeId]
        : undefined;
      if (step) result = ownPathValue(step.output, parsed.path);
    }
    if (!result.found) {
      throw new Error(`binding "${source}" could not be resolved`);
    }
    resolved[name] = result.value;
  }
  return resolved;
}
