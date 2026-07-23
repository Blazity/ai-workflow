import {
  isSafeWorkflowInputName,
  type BlockOutput,
  type JsonValue,
  type WorkflowDataReferenceV2,
  type WorkflowDefinitionV2Node,
  type WorkflowInputBindingV2,
} from "@shared/contracts";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const DATA_TOKEN_PATTERN = /\{\{data:([^{}]+)\}\}/g;

export type ParsedWorkflowDataReferenceV2 =
  | { root: "entry"; path: string[] }
  | { root: "steps"; nodeId: string; path: string[] }
  | { root: "run"; path: string[] };

export interface V2BindingResolutionContext {
  entryOutput: BlockOutput;
  runValues?: Readonly<Record<string, unknown>>;
  getStepOutput(nodeId: string): BlockOutput | undefined;
}

function safeSegments(reference: string): string[] | null {
  if (reference.trim() !== reference) return null;
  const segments = reference.split(".");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        /\s/.test(segment) ||
        FORBIDDEN_SEGMENTS.has(segment),
    )
  ) {
    return null;
  }
  return segments;
}

export function parseWorkflowDataReferenceV2(
  reference: string,
): ParsedWorkflowDataReferenceV2 | null {
  const segments = safeSegments(reference);
  if (!segments) return null;
  if (segments[0] === "run" && segments.length >= 2) {
    return { root: "run", path: segments.slice(1) };
  }
  if (
    segments[0] !== "steps" ||
    segments.length < 4 ||
    segments[2] !== "output"
  ) {
    return null;
  }
  if (segments[1] === "entry") {
    return { root: "entry", path: segments.slice(3) };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segments[1]!)) return null;
  return {
    root: "steps",
    nodeId: segments[1]!,
    path: segments.slice(3),
  };
}

function ownPathValue(
  root: unknown,
  path: readonly string[],
): { found: boolean; value?: unknown } {
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

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

export function resolveWorkflowDataReferenceV2(
  reference: WorkflowDataReferenceV2,
  context: V2BindingResolutionContext,
): unknown {
  const parsed = parseWorkflowDataReferenceV2(reference);
  let result: { found: boolean; value?: unknown } = { found: false };
  if (parsed?.root === "entry") {
    result = ownPathValue(context.entryOutput, parsed.path);
  } else if (parsed?.root === "run") {
    result = ownPathValue(context.runValues, parsed.path);
  } else if (parsed?.root === "steps") {
    result = ownPathValue(context.getStepOutput(parsed.nodeId), parsed.path);
  }
  if (!result.found) {
    throw new Error(`binding "${reference}" could not be resolved`);
  }
  return cloneJsonValue(result.value);
}

function promptDataValue(value: unknown, reference: string): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`prompt data reference "${reference}" is not JSON serializable`);
  }
  return serialized;
}

/**
 * Resolves the canonical data chips persisted in v2 prompt-bearing fields.
 * Definition validation has already proved the references available; resolving
 * them again at invocation time prevents a stale or corrupt checkpoint from
 * leaking a raw placeholder into an agent prompt.
 */
export function resolveWorkflowPromptDataTokensV2(
  text: string,
  context: V2BindingResolutionContext,
): string {
  return text.replace(DATA_TOKEN_PATTERN, (_token, reference: string) =>
    promptDataValue(
      resolveWorkflowDataReferenceV2(
        reference as WorkflowDataReferenceV2,
        context,
      ),
      reference,
    ),
  );
}

export function resolveWorkflowInputBindingV2(
  binding: WorkflowInputBindingV2,
  context: V2BindingResolutionContext,
): unknown {
  if (binding.kind === "literal") return cloneJsonValue(binding.value);
  return resolveWorkflowDataReferenceV2(binding.reference, context);
}

export function resolveWorkflowNodeInputsV2(
  node: Pick<WorkflowDefinitionV2Node, "inputs" | "additionalInputs">,
  context: V2BindingResolutionContext,
): Record<string, unknown> {
  const bindings = new Map<string, WorkflowInputBindingV2>();
  for (const [name, binding] of Object.entries(node.inputs)) {
    if (!isSafeWorkflowInputName(name)) {
      throw new Error(`input name "${name}" is not safe`);
    }
    bindings.set(name, binding);
  }
  for (const input of node.additionalInputs) {
    if (!isSafeWorkflowInputName(input.name)) {
      throw new Error(`input name "${input.name}" is not safe`);
    }
    if (bindings.has(input.name)) {
      throw new Error(`input name "${input.name}" is declared more than once`);
    }
    bindings.set(input.name, input.binding);
  }

  const resolved: Record<string, unknown> = {};
  for (const [name, binding] of bindings) {
    resolved[name] = resolveWorkflowInputBindingV2(binding, context);
  }
  return resolved;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}
