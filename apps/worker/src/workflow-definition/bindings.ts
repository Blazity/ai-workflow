import type {
  BlockOutput,
  WorkflowBindingSource,
  WorkflowBlockInputContract,
  WorkflowDefinition,
  WorkflowDefinitionNode,
  WorkflowInputBindings,
  WorkflowValueSchema,
} from "@shared/contracts";
import { BLOCK_TYPE_SPECS, FAILURE_PORT } from "@shared/contracts";
import type { StepsRecord } from "./interpreter.js";
import {
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

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
  nodeById: Map<string, WorkflowDefinitionNode>;
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

export function isSafeWorkflowInputName(name: string): boolean {
  if (name.trim() !== name) return false;
  const segments = name.split(".");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        /^[A-Za-z0-9_-]+$/.test(segment) && !FORBIDDEN_SEGMENTS.has(segment),
    )
  );
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
      if (sourceChild && !isWorkflowSchemaAssignable(sourceChild, targetChild)) return false;
    }
  }
  return true;
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
  definition: WorkflowDefinition,
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
  definition: WorkflowDefinition,
  registryContext: WorkflowBlockRegistryContext,
  graphContext = buildWorkflowBindingGraphContext(definition),
): string[] {
  const issues: string[] = [];
  const {
    nodeById,
    dominators,
    reachableFromTrigger,
    reachableFromNode,
    outgoing,
  } = graphContext;

  for (const node of definition.nodes) {
    const contract = resolveWorkflowBlockContract(node.type, node.params, registryContext);
    for (const [inputName, inputContract] of Object.entries(contract.inputs)) {
      if (
        inputContract.required &&
        !Object.prototype.hasOwnProperty.call(node.inputs, inputName)
      ) {
        issues.push(`Block "${node.id}" is missing required input "${inputName}".`);
      }
    }

    for (const [inputName, source] of Object.entries(node.inputs)) {
      const inputContract = inputContractFor(contract, inputName);
      if (!inputContract) {
        issues.push(`Block "${node.id}" has unknown input "${inputName}".`);
        continue;
      }

      const parsed = parseWorkflowBindingSource(source);
      if (!parsed) {
        issues.push(`Block "${node.id}" input "${inputName}" has invalid binding "${source}".`);
        continue;
      }

      if (node.type === "open_pr" && inputName === "publicationAttemptId") {
        const sourceNode = parsed.root === "steps" ? nodeById.get(parsed.nodeId) : undefined;
        const isExactFinalizeOutput =
          parsed.root === "steps" &&
          parsed.path.length === 1 &&
          parsed.path[0] === "publicationAttemptId" &&
          sourceNode?.type === "finalize_workspace" &&
          (dominators.get(node.id)?.has(parsed.nodeId) ?? false);
        if (!isExactFinalizeOutput) {
          issues.push(
            `Block "${node.id}" input "publicationAttemptId" must bind exactly to steps.<finalize_workspace_id>.output.publicationAttemptId from a dominating Finalize Workspace block.`,
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
          issues.push(
            `Block "${node.id}" input "${inputName}" references missing field "${source}"${sourceLabel}.`,
          );
          return;
        }
        const guaranteed = resolveRequiredWorkflowSchemaPath(sourceSchema, path);
        if (!guaranteed) {
          issues.push(
            `Block "${node.id}" input "${inputName}" ${notGuaranteedReason}.`,
          );
          return;
        }
        if (!isWorkflowSchemaAssignable(guaranteed, inputContract.schema)) {
          issues.push(
            `Block "${node.id}" input "${inputName}" expects ${schemaLabel(inputContract.schema)} but "${source}" provides ${schemaLabel(guaranteed)}.`,
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
          issues.push(`Block "${node.id}" input "${inputName}" references itself.`);
          continue;
        }
        const sourceNode = nodeById.get(parsed.nodeId);
        if (!sourceNode) {
          issues.push(
            `Block "${node.id}" input "${inputName}" references unknown block "${parsed.nodeId}".`,
          );
          continue;
        }
        if (!(dominators.get(node.id)?.has(parsed.nodeId) ?? false)) {
          const downstream = dominators.get(parsed.nodeId)?.has(node.id) ?? false;
          issues.push(
            `Block "${node.id}" input "${inputName}" references ${downstream ? "downstream" : "a block that does not dominate it"}: "${parsed.nodeId}".`,
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

  return [...new Set(issues)];
}
