import {
  FAILURE_PORT,
  isTriggerBlockType,
  type WorkflowBindingSource,
  type WorkflowBlockContract,
  type WorkflowBlockInputContract,
  type WorkflowDefinition,
  type WorkflowDefinitionNode,
  type WorkflowEditorOptions,
  type WorkflowParamValue,
  type WorkflowValueSchema,
} from "@shared/contracts";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export interface BindingEditorRow {
  name: string;
  required: boolean;
  variadic: boolean;
  legacy: boolean;
  value: string;
  suggestions: WorkflowBindingSource[];
}

export function paramsAfterBindingRepair(
  node: Pick<WorkflowDefinitionNode, "type" | "params" | "inputs">,
  validatedInputNames: ReadonlySet<string>,
): Record<string, WorkflowParamValue> {
  const params = { ...node.params };
  if (
    node.type === "arthur_injection_check" &&
    validatedInputNames.has("content") &&
    typeof node.inputs.content === "string" &&
    node.inputs.content.trim() !== ""
  ) {
    delete params.legacyContentFromStep;
  }
  if (
    node.type === "finalize_workspace" &&
    Array.isArray(params.legacyRequiredChecks)
  ) {
    const remaining = params.legacyRequiredChecks.filter((sourceId) => {
      if (!validatedInputNames.has(`checks.${sourceId}`)) return true;
      const value = node.inputs[`checks.${sourceId}`];
      return typeof value !== "string" || value.trim() === "";
    });
    if (remaining.length === 0) delete params.legacyRequiredChecks;
    else params.legacyRequiredChecks = remaining;
  }
  return params;
}

export function removeLegacyRequiredCheck(
  params: Record<string, WorkflowParamValue>,
  sourceId: string,
): Record<string, WorkflowParamValue> {
  if (!Array.isArray(params.legacyRequiredChecks)) return params;
  const next = { ...params };
  const remaining = params.legacyRequiredChecks.filter((id) => id !== sourceId);
  if (remaining.length === 0) delete next.legacyRequiredChecks;
  else next.legacyRequiredChecks = remaining;
  return next;
}

export interface BindingEditorInput {
  definition: WorkflowDefinition;
  consumerId: string;
  options: WorkflowEditorOptions;
  nodeContracts?: Record<string, WorkflowBlockContract>;
}

function contractForNode(
  input: BindingEditorInput,
  nodeId: string,
): WorkflowBlockContract | null {
  const node = input.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  return input.nodeContracts?.[nodeId] ?? input.options.blockRegistry[node.type];
}

function isSafeInputName(name: string): boolean {
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

function resolveRequiredPath(
  schema: WorkflowValueSchema,
  path: readonly string[],
): WorkflowValueSchema | null {
  let current = schema;
  for (const segment of path) {
    if (current.type !== "object" || !current.required.includes(segment)) return null;
    const child = current.properties[segment];
    if (!child) return null;
    current = child;
  }
  return current;
}

function requiredPaths(
  schema: WorkflowValueSchema,
  prefix: string[] = [],
): Array<{ path: string[]; schema: WorkflowValueSchema }> {
  if (schema.type !== "object") return [];
  const paths: Array<{ path: string[]; schema: WorkflowValueSchema }> = [];
  for (const key of schema.required) {
    const child = schema.properties[key];
    if (!child || FORBIDDEN_SEGMENTS.has(key)) continue;
    const path = [...prefix, key];
    paths.push({ path, schema: child });
    if (child.type === "object") paths.push(...requiredPaths(child, path));
  }
  return paths;
}

function isAssignable(source: WorkflowValueSchema, target: WorkflowValueSchema): boolean {
  if (target.type === "unknown") return true;
  if (source.type === "unknown") return false;
  if (target.type === "nullable") {
    if (source.type === "null") return true;
    return source.type === "nullable"
      ? isAssignable(source.value, target.value)
      : isAssignable(source, target.value);
  }
  if (source.type === "nullable" || source.type !== target.type) return false;
  if (source.type === "array" && target.type === "array") {
    return isAssignable(source.items, target.items);
  }
  if (source.type === "object" && target.type === "object") {
    for (const required of target.required) {
      const sourceChild = source.properties[required];
      const targetChild = target.properties[required];
      if (!sourceChild || !targetChild || !source.required.includes(required)) return false;
      if (!isAssignable(sourceChild, targetChild)) return false;
    }
    for (const [key, targetChild] of Object.entries(target.properties)) {
      const sourceChild = source.properties[key];
      if (sourceChild && !isAssignable(sourceChild, targetChild)) return false;
    }
  }
  return true;
}

function reachableFrom(seed: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set([seed]);
  const queue = [seed];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency.get(queue[index]!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function dominators(
  entries: readonly string[],
  reachable: Set<string>,
  predecessors: Map<string, string[]>,
): Map<string, Set<string>> {
  const entrySet = new Set(entries.filter((id) => reachable.has(id)));
  const universe = [...reachable];
  const result = new Map<string, Set<string>>();
  for (const id of universe) {
    result.set(id, entrySet.has(id) ? new Set([id]) : new Set(universe));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of universe) {
      if (entrySet.has(id)) continue;
      const incoming = (predecessors.get(id) ?? []).filter((candidate) => reachable.has(candidate));
      let next: Set<string> | null = null;
      for (const predecessor of incoming) {
        const predecessorSet = result.get(predecessor) ?? new Set<string>();
        if (next === null) next = new Set(predecessorSet);
        else for (const candidate of [...next]) if (!predecessorSet.has(candidate)) next.delete(candidate);
      }
      next ??= new Set();
      next.add(id);
      const current = result.get(id) ?? new Set<string>();
      if (next.size !== current.size || [...next].some((candidate) => !current.has(candidate))) {
        result.set(id, next);
        changed = true;
      }
    }
  }
  return result;
}

function bindingSuggestions(
  input: BindingEditorInput,
  target: WorkflowValueSchema,
): WorkflowBindingSource[] {
  const { definition, consumerId } = input;
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const forward = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  const reverse = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to) || edge.from === edge.to) continue;
    forward.get(edge.from)?.push(edge.to);
    reverse.get(edge.to)?.push(edge.from);
  }

  const triggers = definition.nodes.filter((node) => isTriggerBlockType(node.type));
  const reachableByNode = new Map(
    definition.nodes.map((node) => [node.id, reachableFrom(node.id, forward)]),
  );
  const reachingTriggers = triggers.filter((trigger) =>
    reachableByNode.get(trigger.id)?.has(consumerId),
  );
  const reachable = new Set<string>();
  for (const trigger of triggers) {
    for (const id of reachableByNode.get(trigger.id) ?? []) reachable.add(id);
  }
  const dominatedBy = dominators(
    triggers.map((trigger) => trigger.id),
    reachable,
    reverse,
  );
  const suggestions: WorkflowBindingSource[] = [];

  if (reachingTriggers.length > 0) {
    const schemas = reachingTriggers
      .map((trigger) => contractForNode(input, trigger.id)?.output.bindingSchema)
      .filter((schema): schema is WorkflowValueSchema => schema !== undefined);
    const first = schemas[0];
    if (first && schemas.length === reachingTriggers.length) {
      for (const candidate of requiredPaths(first)) {
        if (
          schemas.every((schema) => {
            const resolved = resolveRequiredPath(schema, candidate.path);
            return resolved !== null && isAssignable(resolved, target);
          })
        ) {
          suggestions.push(`trigger.${candidate.path.join(".")}`);
        }
      }
    }
  }

  for (const sourceNode of definition.nodes) {
    if (
      sourceNode.id === consumerId ||
      isTriggerBlockType(sourceNode.type) ||
      !(dominatedBy.get(consumerId)?.has(sourceNode.id) ?? false)
    ) {
      continue;
    }
    const sourceContract = contractForNode(input, sourceNode.id);
    if (!sourceContract) continue;
    const pathSchemas = definition.edges
      .filter(
        (edge) =>
          edge.from === sourceNode.id &&
          (reachableByNode.get(edge.to)?.has(consumerId) ?? false),
      )
      .map((edge) => {
        const port = edge.fromPort ?? sourceContract.ports[0];
        return port === FAILURE_PORT
          ? sourceContract.output.schema
          : sourceContract.output.bindingSchema;
      });
    if (pathSchemas.length === 0) continue;
    for (const candidate of requiredPaths(pathSchemas[0]!)) {
      if (
        pathSchemas.every((schema) => {
          const resolved = resolveRequiredPath(schema, candidate.path);
          return resolved !== null && isAssignable(resolved, target);
        })
      ) {
        suggestions.push(`steps.${sourceNode.id}.output.${candidate.path.join(".")}`);
      }
    }
  }

  for (const candidate of requiredPaths(input.options.runBindingSchema)) {
    if (isAssignable(candidate.schema, target)) {
      suggestions.push(`run.${candidate.path.join(".")}`);
    }
  }

  return [...new Set(suggestions)];
}

function inputContract(
  contract: WorkflowBlockContract,
  name: string,
): { input: WorkflowBlockInputContract; variadic: boolean; legacy: boolean } {
  const fixed = contract.inputs[name];
  if (fixed) return { input: fixed, variadic: false, legacy: false };
  const additional = contract.additionalInputs.find(({ keyPattern }) =>
    new RegExp(keyPattern).test(name),
  );
  if (additional) {
    return {
      input: { required: false, schema: additional.schema },
      variadic: true,
      legacy: false,
    };
  }
  return {
    input: { required: false, schema: { type: "unknown" } },
    variadic: true,
    legacy: true,
  };
}

export function buildBindingEditorRows(input: BindingEditorInput): BindingEditorRow[] {
  const node = input.definition.nodes.find((candidate) => candidate.id === input.consumerId);
  const contract = contractForNode(input, input.consumerId);
  if (!node || !contract) return [];
  const names = [
    ...Object.keys(contract.inputs),
    ...Object.keys(node.inputs).filter((name) => !Object.hasOwn(contract.inputs, name)),
  ];
  return names.map((name) => {
    const resolved = inputContract(contract, name);
    return {
      name,
      required: resolved.input.required,
      variadic: resolved.variadic,
      legacy: resolved.legacy,
      value: node.inputs[name] ?? "",
      suggestions: bindingSuggestions(input, resolved.input.schema),
    };
  });
}

/** Returns only current bindings that the authoring model can prove valid with
 * the server-resolved contracts for this exact graph. Drafts may contain
 * invalid bindings, so mere presence is never enough to retire a compatibility
 * marker. */
export function validatedBindingInputNames(input: BindingEditorInput): string[] {
  return buildBindingEditorRows(input)
    .filter(
      (row) =>
        !row.legacy &&
        row.value !== "" &&
        row.suggestions.some((suggestion) => suggestion === row.value),
    )
    .map((row) => row.name);
}

export function canAddAdditionalInput(
  name: string,
  rows: readonly Pick<BindingEditorRow, "name">[],
  contract: WorkflowBlockContract,
): { allowed: boolean; reason: string | null } {
  if (!isSafeInputName(name)) {
    return { allowed: false, reason: "Input names use letters, numbers, dashes, underscores, and dots." };
  }
  if (rows.some((row) => row.name === name)) {
    return { allowed: false, reason: "That input already exists." };
  }
  if (!contract.additionalInputs.some(({ keyPattern }) => new RegExp(keyPattern).test(name))) {
    return { allowed: false, reason: "That input name does not match an additional input supported by this block." };
  }
  return { allowed: true, reason: null };
}
