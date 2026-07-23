import type {
  BlockOutput,
  JsonValue,
  WorkflowBindingSource,
  WorkflowBlockInputContract,
  WorkflowDefinitionV1,
  WorkflowDefinitionV1Node,
  WorkflowDefinitionValidationIssue,
  WorkflowInputBindings,
  WorkflowValueSchema,
} from "@shared/contracts";
import {
  BLOCK_TYPE_SPECS,
  FAILURE_PORT,
  isSafeWorkflowInputName,
} from "@shared/contracts";
import type { StepsRecord } from "./interpreter.js";
import {
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

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

export interface WorkflowBindingGraphContext {
  nodeById: Map<string, WorkflowDefinitionV1Node>;
  reachable: Set<string>;
  dominators: Map<string, Set<string>>;
  reachableFromTrigger: Map<string, Set<string>>;
  reachableFromNode: Map<string, Set<string>>;
  outgoing: Map<string, Array<{ to: string; port: string }>>;
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

/** Resolve only fields whose presence is guaranteed by the schema. Array
 * indices and traversal through nullable values are intentionally excluded:
 * neither an array length nor a non-null value is guaranteed by this schema
 * language. */
export function resolveRequiredWorkflowSchemaPath(
  schema: WorkflowValueSchema,
  path: readonly string[],
): WorkflowValueSchema | null {
  let current = schema;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (FORBIDDEN_SEGMENTS.has(segment)) return null;
    if (current.type === "nullable") return null;
    if (current.type !== "object") return null;
    if (
      !current.required.includes(segment) ||
      !Object.prototype.hasOwnProperty.call(current.properties, segment)
    ) {
      return null;
    }
    current = current.properties[segment];
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

export function isWorkflowBindingSource(source: string): source is WorkflowBindingSource {
  return parseWorkflowBindingSource(source) !== null;
}

function reachableFrom(seed: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set([seed]);
  const queue = [seed];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency.get(queue[index]) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export function computeWorkflowDominators(
  entries: readonly string[],
  reachable: Set<string>,
  predecessors: Map<string, string[]>,
): Map<string, Set<string>> {
  const entrySet = new Set(entries.filter((id) => reachable.has(id)));
  const universe = [...reachable];
  const dominators = new Map<string, Set<string>>();
  for (const id of universe) {
    dominators.set(id, entrySet.has(id) ? new Set([id]) : new Set(universe));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of universe) {
      if (entrySet.has(id)) continue;
      const predecessorsForNode = (predecessors.get(id) ?? []).filter((candidate) =>
        reachable.has(candidate),
      );
      let next: Set<string> | null = null;
      for (const predecessor of predecessorsForNode) {
        const predecessorDominators = dominators.get(predecessor) ?? new Set<string>();
        if (next === null) {
          next = new Set(predecessorDominators);
        } else {
          for (const candidate of [...next]) {
            if (!predecessorDominators.has(candidate)) next.delete(candidate);
          }
        }
      }
      next ??= new Set();
      next.add(id);
      const current = dominators.get(id) ?? new Set<string>();
      if (next.size !== current.size || [...next].some((candidate) => !current.has(candidate))) {
        dominators.set(id, next);
        changed = true;
      }
    }
  }
  return dominators;
}

export function buildWorkflowBindingGraphContext(
  definition: WorkflowDefinitionV1,
): WorkflowBindingGraphContext {
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const outgoing = new Map<string, Array<{ to: string; port: string }>>();
  for (const node of definition.nodes) {
    forward.set(node.id, []);
    reverse.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of definition.edges) {
    if (edge.from === edge.to || !nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    forward.get(edge.from)?.push(edge.to);
    reverse.get(edge.to)?.push(edge.from);
    const source = nodeById.get(edge.from);
    if (source) {
      const port = edge.fromPort ?? BLOCK_TYPE_SPECS[source.type].ports[0];
      if (port !== undefined) outgoing.get(edge.from)?.push({ to: edge.to, port });
    }
  }
  const triggers = definition.nodes.filter(
    (node) => node.type.startsWith("trigger_"),
  );
  const reachableFromTrigger = new Map(
    triggers.map((trigger) => [trigger.id, reachableFrom(trigger.id, forward)]),
  );
  const reachable = new Set<string>();
  for (const triggerReachable of reachableFromTrigger.values()) {
    for (const id of triggerReachable) reachable.add(id);
  }
  return {
    nodeById,
    reachable,
    dominators: computeWorkflowDominators(
      triggers.map((trigger) => trigger.id),
      reachable,
      reverse,
    ),
    reachableFromTrigger,
    reachableFromNode: new Map(
      definition.nodes.map((node) => [node.id, reachableFrom(node.id, forward)]),
    ),
    outgoing,
  };
}

function schemaLabel(schema: WorkflowValueSchema): string {
  return schema.type;
}

function inputContractFor(
  contract: ReturnType<typeof resolveWorkflowBlockContract>,
  inputName: string,
): WorkflowBlockInputContract | null {
  const fixed = Object.prototype.hasOwnProperty.call(contract.inputs, inputName)
    ? contract.inputs[inputName]
    : undefined;
  if (fixed) return fixed;
  if (!isSafeWorkflowInputName(inputName)) return null;
  const additional = contract.additionalInputs.find(({ keyPattern }) =>
    new RegExp(keyPattern).test(inputName),
  );
  return additional ? { required: false, schema: additional.schema } : null;
}

export function validateWorkflowBindings(
  definition: WorkflowDefinitionV1,
  registryContext: WorkflowBlockRegistryContext,
  graphContext = buildWorkflowBindingGraphContext(definition),
): string[] {
  return validateWorkflowBindingIssues(definition, registryContext, graphContext).map(
    ({ message }) => message,
  );
}

export function validateWorkflowBindingIssues(
  definition: WorkflowDefinitionV1,
  registryContext: WorkflowBlockRegistryContext,
  graphContext = buildWorkflowBindingGraphContext(definition),
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const addIssue = (nodeId: string, message: string, path?: string) => {
    issues.push({
      code: "deployment",
      severity: "error",
      nodeId,
      ...(path ? { path } : {}),
      message,
    });
  };
  const {
    nodeById,
    dominators,
    reachableFromTrigger,
    reachableFromNode,
    outgoing,
  } = graphContext;

  for (const [nodeIndex, node] of definition.nodes.entries()) {
    const contract = resolveWorkflowBlockContract(node.type, node.params, registryContext);
    for (const [inputName, inputContract] of Object.entries(contract.inputs)) {
      if (
        inputContract.required &&
        !Object.prototype.hasOwnProperty.call(node.inputs, inputName)
      ) {
        addIssue(
          node.id,
          `Block "${node.id}" is missing required input "${inputName}".`,
          `/nodes/${nodeIndex}/inputs/${inputName}`,
        );
      }
    }

    for (const [inputName, source] of Object.entries(node.inputs)) {
      const inputContract = inputContractFor(contract, inputName);
      if (!inputContract) {
        addIssue(
          node.id,
          `Block "${node.id}" has unknown input "${inputName}".`,
          `/nodes/${nodeIndex}/inputs/${inputName}`,
        );
        continue;
      }

      const parsed = parseWorkflowBindingSource(source);
      if (!parsed) {
        addIssue(
          node.id,
          `Block "${node.id}" input "${inputName}" has invalid binding "${source}".`,
          `/nodes/${nodeIndex}/inputs/${inputName}`,
        );
        continue;
      }

      if (node.type === "open_pr" && inputName === "repositories") {
        const sourceNode = parsed.root === "steps" ? nodeById.get(parsed.nodeId) : undefined;
        const isExactFinalizeOutput =
          parsed.root === "steps" &&
          parsed.path.length === 1 &&
          parsed.path[0] === "repositories" &&
          sourceNode?.type === "finalize_workspace" &&
          (dominators.get(node.id)?.has(parsed.nodeId) ?? false);
        if (!isExactFinalizeOutput) {
          addIssue(
            node.id,
            `Block "${node.id}" input "repositories" must bind exactly to steps.<finalize_workspace_id>.output.repositories from a dominating Finalize Workspace block.`,
            `/nodes/${nodeIndex}/inputs/repositories`,
          );
          continue;
        }
      }

      const comparePath = (
        sourceSchema: WorkflowValueSchema,
        path: readonly string[],
        sourceLabel: string,
        notGuaranteedReason: string,
      ): void => {
        const declared = resolveWorkflowSchemaPath(sourceSchema, path);
        if (!declared) {
          addIssue(
            node.id,
            `Block "${node.id}" input "${inputName}" references missing field "${source}"${sourceLabel}.`,
            `/nodes/${nodeIndex}/inputs/${inputName}`,
          );
          return;
        }
        const guaranteed = resolveRequiredWorkflowSchemaPath(sourceSchema, path);
        if (!guaranteed) {
          addIssue(
            node.id,
            `Block "${node.id}" input "${inputName}" ${notGuaranteedReason}.`,
            `/nodes/${nodeIndex}/inputs/${inputName}`,
          );
          return;
        }
        if (!isWorkflowSchemaAssignable(guaranteed, inputContract.schema)) {
          addIssue(
            node.id,
            `Block "${node.id}" input "${inputName}" expects ${schemaLabel(inputContract.schema)} but "${source}" provides ${schemaLabel(guaranteed)}.`,
            `/nodes/${nodeIndex}/inputs/${inputName}`,
          );
        }
      };

      if (parsed.root === "run") {
        comparePath(
          RUN_BINDING_SCHEMA,
          parsed.path,
          "",
          `references "${source}", which is not guaranteed at run time`,
        );
        continue;
      }

      if (parsed.root === "steps") {
        if (parsed.nodeId === node.id) {
          addIssue(
            node.id,
            `Block "${node.id}" input "${inputName}" references itself.`,
            `/nodes/${nodeIndex}/inputs/${inputName}`,
          );
          continue;
        }
        const sourceNode = nodeById.get(parsed.nodeId);
        if (!sourceNode) {
          addIssue(
            node.id,
            `Block "${node.id}" input "${inputName}" references unknown block "${parsed.nodeId}".`,
            `/nodes/${nodeIndex}/inputs/${inputName}`,
          );
          continue;
        }
        if (!(dominators.get(node.id)?.has(parsed.nodeId) ?? false)) {
          const downstream = dominators.get(parsed.nodeId)?.has(node.id) ?? false;
          addIssue(
            node.id,
            `Block "${node.id}" input "${inputName}" references ${downstream ? "downstream" : "a block that does not dominate it"}: "${parsed.nodeId}".`,
            `/nodes/${nodeIndex}/inputs/${inputName}`,
          );
          continue;
        }
        const sourceContract = resolveWorkflowBlockContract(
          sourceNode.type,
          sourceNode.params,
          registryContext,
        );
        const pathsToConsumer = (outgoing.get(sourceNode.id) ?? []).filter(({ to }) =>
          reachableFromNode.get(to)?.has(node.id),
        );
        for (const path of pathsToConsumer) {
          const throughFailure = path.port === FAILURE_PORT;
          comparePath(
            throughFailure
              ? sourceContract.output.schema
              : sourceContract.output.bindingSchema,
            parsed.path,
            "",
            throughFailure
              ? `references "${source}", which may reach "${node.id}" through its failure port without that field`
              : `references "${source}", which is not guaranteed on normal output`,
          );
        }
        continue;
      }

      const reachingTriggers = definition.nodes.filter(
        (candidate) =>
          candidate.type.startsWith("trigger_") &&
          (reachableFromTrigger.get(candidate.id)?.has(node.id) ?? false),
      );
      for (const trigger of reachingTriggers) {
        const triggerContract = resolveWorkflowBlockContract(
          trigger.type,
          trigger.params,
          registryContext,
        );
        comparePath(
          triggerContract.output.bindingSchema,
          parsed.path,
          ` for trigger "${trigger.id}"`,
          `references "${source}", which is not guaranteed for trigger "${trigger.id}"`,
        );
      }
    }
  }

  return issues.filter(
    (issue, index) =>
      issues.findIndex(
        (candidate) =>
          candidate.nodeId === issue.nodeId &&
          candidate.path === issue.path &&
          candidate.message === issue.message,
      ) === index,
  );
}
