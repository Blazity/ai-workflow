import {
  BLOCK_TYPE_SPECS,
  isTriggerBlockType,
  isWorkflowAddressablePathSegment,
  type JsonSchema202012,
  type JsonValue,
  type TransformConfiguration,
  type WorkflowBlockContract,
  type WorkflowAvailableValue,
  type WorkflowAvailableValuesByNode,
  type WorkflowDefinitionV2,
  type WorkflowDefinitionV2ControlEdge,
  type WorkflowDefinitionV2Node,
  type WorkflowDefinitionValidationIssue,
  type WorkflowInputBindingV2,
  type WorkflowParamValue,
  type WorkflowValueSchema,
} from "@shared/contracts";
import {
  isSafeWorkflowInputName,
  isWorkflowSchemaAssignable,
  RUN_BINDING_SCHEMA,
} from "./bindings.js";
import {
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";
import {
  inspectJsonSchema202012,
  validateJsonSchemaValue,
} from "./json-schema.js";
import { deriveTransformOutputSchema } from "./transform.js";

const MAX_ACTIVATION_TERMS = 256;
const TRIGGER_GUARD = "$trigger";

export interface WorkflowV2BindingAnalysis {
  availableValuesByNode: WorkflowAvailableValuesByNode;
  nodeContracts: Record<string, WorkflowBlockContract>;
  issues: WorkflowDefinitionValidationIssue[];
}

interface InputTarget {
  name: string;
  schema: WorkflowValueSchema;
  required: boolean;
  binding: WorkflowInputBindingV2 | undefined;
  path: string;
}

type ActivationTerm = ReadonlyMap<string, string>;

interface ActivationFormula {
  precise: boolean;
  terms: Map<string, ActivationTerm>;
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function configurationParams(node: WorkflowDefinitionV2Node): Record<string, WorkflowParamValue> {
  const params: Record<string, WorkflowParamValue> = {};
  for (const [name, value] of Object.entries(node.configuration)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ) {
      params[name] = value;
    }
  }
  return params;
}

function contractForNode(
  node: WorkflowDefinitionV2Node,
  registryContext: WorkflowBlockRegistryContext,
): WorkflowBlockContract {
  const contract = resolveWorkflowBlockContract(
    node.type,
    configurationParams(node),
    registryContext,
  );
  if (node.type !== "transform") return contract;

  const derived = deriveTransformOutputSchema({
    configuration: node.configuration as unknown as TransformConfiguration,
    inputSchemas: Object.fromEntries(
      node.additionalInputs.map((input) => [input.name, input.schema]),
    ),
  });
  if (!derived) return contract;
  const inspected = inspectJsonSchema202012(derived, {
    requireClosedObjects: true,
  });
  if (!inspected.ok) return contract;

  const replaceOutput = (schema: WorkflowValueSchema): WorkflowValueSchema => {
    if (schema.type !== "object") return schema;
    return {
      ...schema,
      properties: {
        ...schema.properties,
        output: inspected.valueSchema,
      },
      required: schema.required.includes("output")
        ? schema.required
        : [...schema.required, "output"],
    };
  };
  return {
    ...contract,
    output: {
      ...contract.output,
      schema: replaceOutput(contract.output.schema),
      bindingSchema: replaceOutput(contract.output.bindingSchema),
    },
  };
}

function jsonSchemaMetadata(
  schema: WorkflowValueSchema,
): JsonSchema202012 {
  return {
    ...(schema.description === undefined ? {} : { description: schema.description }),
    ...(schema.enum === undefined ? {} : { enum: schema.enum }),
  };
}

/** Convert the registry's derived type language back to the canonical schema
 * shape exposed by the v2 catalog and consumed by the PR 1 validator. */
export function workflowValueSchemaToJsonSchema(
  schema: WorkflowValueSchema,
): JsonSchema202012 {
  const metadata = jsonSchemaMetadata(schema);
  switch (schema.type) {
    case "unknown":
      return {};
    case "string":
    case "number":
    case "boolean":
    case "null":
      return { type: schema.type, ...metadata };
    case "array":
      return {
        type: "array",
        items: workflowValueSchemaToJsonSchema(schema.items),
        ...metadata,
      };
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([name, child]) => [
            name,
            workflowValueSchemaToJsonSchema(child),
          ]),
        ),
        required: schema.required,
        additionalProperties: schema.additionalProperties,
        ...metadata,
      };
    case "nullable": {
      const base = workflowValueSchemaToJsonSchema(schema.value);
      const type = base.type;
      if (typeof type === "string") {
        return { ...base, type: [type, "null"], ...metadata };
      }
      if (Array.isArray(type)) {
        return {
          ...base,
          type: type.includes("null") ? type : [...type, "null"],
          ...metadata,
        };
      }
      return { ...base, ...metadata };
    }
  }
}

function requiredSchemaPaths(
  schema: WorkflowValueSchema,
  prefix: string[] = [],
): Array<{ path: string[]; schema: WorkflowValueSchema }> {
  if (schema.type !== "object") return [];
  const result: Array<{ path: string[]; schema: WorkflowValueSchema }> = [];
  for (const name of schema.required) {
    if (!isWorkflowAddressablePathSegment(name)) continue;
    const child = schema.properties[name];
    if (!child) continue;
    const path = [...prefix, name];
    result.push({ path, schema: child });
    result.push(...requiredSchemaPaths(child, path));
  }
  return result;
}

function requiredSchemaAtPath(
  schema: WorkflowValueSchema,
  path: readonly string[],
): WorkflowValueSchema | null {
  let current = schema;
  for (const name of path) {
    if (current.type !== "object" || !current.required.includes(name)) return null;
    const child = current.properties[name];
    if (!child) return null;
    current = child;
  }
  return current;
}

function commonMetadata(schemas: readonly WorkflowValueSchema[]) {
  const first = schemas[0];
  if (!first) return {};
  const description = schemas.every((schema) => schema.description === first.description)
    ? first.description
    : undefined;
  const enums = schemas.map((schema) => schema.enum);
  const enumValues =
    enums.every((values) => values !== undefined)
      ? [
          ...new Map(
            enums
              .flatMap((values) => values ?? [])
              .map((value) => [JSON.stringify(value), value]),
          ).values(),
        ]
      : undefined;
  return {
    ...(description === undefined ? {} : { description }),
    ...(enumValues === undefined ? {} : { enum: enumValues }),
  };
}

/** Safely describe a value emitted by any of the active trigger contracts.
 * The result is a supertype: object requirements are intersected and enums are
 * unioned, so compatibility never assumes a field/value absent from one trigger. */
function commonSourceSchema(
  schemas: readonly WorkflowValueSchema[],
): WorkflowValueSchema | null {
  const first = schemas[0];
  if (!first) return null;
  const metadata = commonMetadata(schemas);
  const nullable = schemas.some((schema) => schema.type === "nullable");
  const values = schemas.map((schema) =>
    schema.type === "nullable" ? schema.value : schema,
  );
  const firstValue = values[0]!;
  if (values.some((schema) => schema.type !== firstValue.type)) return null;

  let merged: WorkflowValueSchema;
  switch (firstValue.type) {
    case "unknown":
      merged = { type: "unknown", ...metadata };
      break;
    case "string":
    case "number":
    case "boolean":
    case "null":
      merged = { type: firstValue.type, ...metadata };
      break;
    case "array": {
      const items = commonSourceSchema(
        values.map((schema) => (schema.type === "array" ? schema.items : firstValue.items)),
      );
      if (!items) return null;
      merged = { type: "array", items, ...metadata };
      break;
    }
    case "object": {
      const objects = values.filter(
        (schema): schema is Extract<WorkflowValueSchema, { type: "object" }> =>
          schema.type === "object",
      );
      const names = Object.keys(firstValue.properties).filter((name) =>
        objects.every((schema) => Object.hasOwn(schema.properties, name)),
      );
      const properties: Record<string, WorkflowValueSchema> = {};
      for (const name of names) {
        const child = commonSourceSchema(objects.map((schema) => schema.properties[name]!));
        if (child) properties[name] = child;
      }
      const required = firstValue.required.filter(
        (name) =>
          Object.hasOwn(properties, name) &&
          objects.every((schema) => schema.required.includes(name)),
      );
      merged = {
        type: "object",
        properties,
        required,
        additionalProperties: objects.some((schema) => schema.additionalProperties),
        ...metadata,
      };
      break;
    }
    case "nullable":
      return null;
  }
  return nullable && merged.type !== "null"
    ? { type: "nullable", value: merged, ...metadata }
    : merged;
}

function termKey(term: ActivationTerm): string {
  return JSON.stringify([...term].sort(([left], [right]) => left.localeCompare(right)));
}

function oneTerm(variable: string, value: string): ActivationFormula {
  const term = new Map([[variable, value]]);
  return { precise: true, terms: new Map([[termKey(term), term]]) };
}

function emptyFormula(): ActivationFormula {
  return { precise: true, terms: new Map() };
}

function guardedFormula(
  formula: ActivationFormula,
  variable: string,
  value: string,
): ActivationFormula {
  const result = emptyFormula();
  result.precise = formula.precise;
  for (const term of formula.terms.values()) {
    const existing = term.get(variable);
    if (existing !== undefined && existing !== value) continue;
    const guarded = new Map(term);
    guarded.set(variable, value);
    result.terms.set(termKey(guarded), guarded);
  }
  return result;
}

function mergeFormula(
  target: ActivationFormula,
  source: ActivationFormula,
): void {
  if (!source.precise) target.precise = false;
  for (const [key, term] of source.terms) {
    if (target.terms.has(key)) continue;
    if (target.terms.size >= MAX_ACTIVATION_TERMS) {
      target.precise = false;
      continue;
    }
    target.terms.set(key, term);
  }
}

function sameFormula(left: ActivationFormula, right: ActivationFormula): boolean {
  return (
    left.precise === right.precise &&
    left.terms.size === right.terms.size &&
    [...left.terms.keys()].every((key) => right.terms.has(key))
  );
}

function resolvedPort(
  edge: WorkflowDefinitionV2ControlEdge,
  source: WorkflowDefinitionV2Node,
): string | null {
  return edge.fromPort ?? BLOCK_TYPE_SPECS[source.type].ports[0] ?? null;
}

function stronglyConnectedNodeIds(definition: WorkflowDefinitionV2): Set<string> {
  const adjacency = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  const selfLoops = new Set<string>();
  for (const edge of definition.edges) {
    adjacency.get(edge.from)?.push(edge.to);
    if (edge.from === edge.to) selfLoops.add(edge.from);
  }

  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const cyclic = new Set<string>();

  const visit = (id: string) => {
    const index = nextIndex++;
    indexById.set(id, index);
    lowById.set(id, index);
    stack.push(id);
    onStack.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!indexById.has(next)) {
        visit(next);
        lowById.set(id, Math.min(lowById.get(id)!, lowById.get(next)!));
      } else if (onStack.has(next)) {
        lowById.set(id, Math.min(lowById.get(id)!, indexById.get(next)!));
      }
    }
    if (lowById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    if (component.length > 1 || selfLoops.has(component[0]!)) {
      for (const member of component) cyclic.add(member);
    }
  };

  for (const node of definition.nodes) {
    if (!indexById.has(node.id)) visit(node.id);
  }
  return cyclic;
}

function activationFormulas(
  definition: WorkflowDefinitionV2,
  nodeById: ReadonlyMap<string, WorkflowDefinitionV2Node>,
  cyclicNodeIds: ReadonlySet<string>,
): Map<string, ActivationFormula> {
  const incoming = new Map(definition.nodes.map((node) => [
    node.id,
    [] as WorkflowDefinitionV2ControlEdge[],
  ]));
  for (const edge of definition.edges) incoming.get(edge.to)?.push(edge);

  let formulas = new Map(
    definition.nodes.map((node) => [
      node.id,
      isTriggerBlockType(node.type)
        ? oneTerm(TRIGGER_GUARD, node.id)
        : emptyFormula(),
    ]),
  );

  const maxRounds = Math.max(1, definition.nodes.length * 2 + 1);
  let converged = false;
  for (let round = 0; round < maxRounds; round += 1) {
    let changed = false;
    const next = new Map<string, ActivationFormula>();
    for (const node of definition.nodes) {
      if (isTriggerBlockType(node.type)) {
        next.set(node.id, formulas.get(node.id)!);
        continue;
      }
      const formula = emptyFormula();
      for (const edge of incoming.get(node.id) ?? []) {
        const source = nodeById.get(edge.from);
        if (!source) continue;
        const sourceFormula = formulas.get(source.id) ?? emptyFormula();
        const port = resolvedPort(edge, source);
        const propagated =
          port !== null && BLOCK_TYPE_SPECS[source.type].ports.length > 1
            ? guardedFormula(sourceFormula, `$port:${source.id}`, port)
            : sourceFormula;
        mergeFormula(formula, propagated);
      }
      if (cyclicNodeIds.has(node.id)) formula.precise = false;
      next.set(node.id, formula);
      if (!sameFormula(formula, formulas.get(node.id) ?? emptyFormula())) changed = true;
    }
    formulas = next;
    if (!changed) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    for (const formula of formulas.values()) formula.precise = false;
  }
  return formulas;
}

function termContains(container: ActivationTerm, required: ActivationTerm): boolean {
  for (const [variable, value] of required) {
    if (container.get(variable) !== value) return false;
  }
  return true;
}

function formulaImplies(
  consumer: ActivationFormula,
  source: ActivationFormula,
): boolean {
  if (
    !consumer.precise ||
    !source.precise ||
    consumer.terms.size === 0 ||
    source.terms.size === 0
  ) {
    return false;
  }
  return [...consumer.terms.values()].every((consumerTerm) =>
    [...source.terms.values()].some((sourceTerm) =>
      termContains(consumerTerm, sourceTerm),
    ),
  );
}

function reachableFrom(
  sourceId: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const result = new Set([sourceId]);
  const queue = [sourceId];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency.get(queue[index]!) ?? []) {
      if (result.has(next)) continue;
      result.add(next);
      queue.push(next);
    }
  }
  return result;
}

function reachingTriggerIds(
  consumerId: string,
  triggerNodes: readonly WorkflowDefinitionV2Node[],
  reachability: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  return triggerNodes
    .filter((trigger) => reachability.get(trigger.id)?.has(consumerId))
    .map((trigger) => trigger.id)
    .sort();
}

function causalEdgeIds(
  sourceId: string,
  consumerId: string,
  definition: WorkflowDefinitionV2,
  reachability: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  return definition.edges
    .filter(
      (edge) =>
        (edge.from === sourceId || reachability.get(sourceId)?.has(edge.from)) &&
        (edge.to === consumerId || reachability.get(edge.to)?.has(consumerId)),
    )
    .map((edge) => edge.id);
}

function targetCompatibility(
  source: WorkflowValueSchema,
  targets: readonly InputTarget[],
): string[] {
  return targets
    .filter((target) => isWorkflowSchemaAssignable(source, target.schema))
    .map((target) => target.name);
}

function inputTargets(
  node: WorkflowDefinitionV2Node,
  nodeIndex: number,
  contract: WorkflowBlockContract,
  issues: WorkflowDefinitionValidationIssue[],
): InputTarget[] {
  const targets: InputTarget[] = Object.entries(contract.inputs).map(([name, input]) => ({
    name,
    schema: input.schema,
    required: input.required,
    binding: node.inputs[name],
    path: `/nodes/${nodeIndex}/inputs/${pointerSegment(name)}`,
  }));

  const fixedNames = new Set(Object.keys(contract.inputs));
  const seenAdditional = new Set<string>();
  for (const [inputIndex, input] of node.additionalInputs.entries()) {
    const basePath = `/nodes/${nodeIndex}/additionalInputs/${inputIndex}`;
    if (
      !isSafeWorkflowInputName(input.name) ||
      fixedNames.has(input.name) ||
      seenAdditional.has(input.name)
    ) {
      issues.push({
        code: "binding.input_name",
        severity: "error",
        nodeId: node.id,
        path: `${basePath}/name`,
        message: `Block "${node.id}" has invalid or duplicate additional input "${input.name}".`,
      });
      continue;
    }
    seenAdditional.add(input.name);
    const parsed = inspectJsonSchema202012(input.schema);
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        issues.push({
          code: `binding.schema.${issue.code}`,
          severity: "error",
          nodeId: node.id,
          path: `${basePath}/schema${issue.path}`,
          message: issue.message.replace(/^outputSchema/, `Input "${input.name}" schema`),
        });
      }
      continue;
    }
    targets.push({
      name: input.name,
      schema: parsed.valueSchema,
      required: true,
      binding: input.binding,
      path: `${basePath}/binding`,
    });
  }
  return targets;
}

function validateLiteral(
  target: InputTarget,
  value: JsonValue,
): Array<{ path: string; message: string }> {
  if (target.schema.type === "unknown") return [];
  return validateJsonSchemaValue(
    workflowValueSchemaToJsonSchema(target.schema),
    value,
  ).map((issue) => ({
    path: `${target.path}/value${issue.path}`,
    message: issue.message,
  }));
}

function validateBindings(
  definition: WorkflowDefinitionV2,
  targetsByNode: ReadonlyMap<string, readonly InputTarget[]>,
  availableValuesByNode: WorkflowAvailableValuesByNode,
  issues: WorkflowDefinitionValidationIssue[],
): void {
  for (const [nodeIndex, node] of definition.nodes.entries()) {
    const targets = targetsByNode.get(node.id) ?? [];
    const targetNames = new Set(targets.map((target) => target.name));
    for (const inputName of Object.keys(node.inputs)) {
      if (targetNames.has(inputName)) continue;
      issues.push({
        code: "binding.unknown_input",
        severity: "error",
        nodeId: node.id,
        path: `/nodes/${nodeIndex}/inputs/${pointerSegment(inputName)}`,
        message: `Block "${node.id}" has unknown fixed input "${inputName}".`,
      });
    }

    const catalog = availableValuesByNode[node.id] ?? [];
    const availableByReference = new Map(
      catalog.map((value) => [value.reference, value]),
    );
    for (const target of targets) {
      if (!target.binding) {
        if (target.required) {
          issues.push({
            code: "binding.required",
            severity: "error",
            nodeId: node.id,
            path: target.path,
            message: `Block "${node.id}" is missing required input "${target.name}".`,
          });
        }
        continue;
      }
      if (node.type === "open_pr" && target.name === "repositories") {
        const binding = target.binding;
        const available =
          binding.kind === "reference"
            ? availableByReference.get(binding.reference)
            : undefined;
        const exactFinalizeReference =
          binding.kind === "reference" &&
          available?.source.kind === "step" &&
          available.source.blockType === "finalize_workspace" &&
          available.source.nodeId !== null &&
          binding.reference ===
            `steps.${available.source.nodeId}.output.repositories`;
        if (!exactFinalizeReference) {
          issues.push({
            code: "binding.open_pr_finalize",
            severity: "error",
            nodeId: node.id,
            path:
              binding.kind === "reference"
                ? `${target.path}/reference`
                : target.path,
            message: `Block "${node.id}" input "repositories" must bind exactly to steps.<finalize_workspace_id>.output.repositories from a guaranteed Finalize Workspace block.`,
          });
          continue;
        }
      }
      if (target.binding.kind === "literal") {
        for (const issue of validateLiteral(target, target.binding.value)) {
          issues.push({
            code: "binding.literal_type",
            severity: "error",
            nodeId: node.id,
            path: issue.path,
            message: `Block "${node.id}" input "${target.name}" ${issue.message}`,
          });
        }
        continue;
      }
      const available = availableByReference.get(target.binding.reference);
      if (!available) {
        issues.push({
          code: "binding.unavailable_reference",
          severity: "error",
          nodeId: node.id,
          path: `${target.path}/reference`,
          message: `Block "${node.id}" input "${target.name}" references "${target.binding.reference}", which is not guaranteed when the block runs.`,
        });
      } else if (!available.compatibleInputNames.includes(target.name)) {
        issues.push({
          code: "binding.reference_type",
          severity: "error",
          nodeId: node.id,
          path: `${target.path}/reference`,
          message: `Block "${node.id}" input "${target.name}" is not compatible with "${target.binding.reference}".`,
        });
      }
    }
  }
}

export function analyzeWorkflowV2Bindings(
  definition: WorkflowDefinitionV2,
  registryContext: WorkflowBlockRegistryContext,
): WorkflowV2BindingAnalysis {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const forward = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  const incoming = new Map(
    definition.nodes.map((node) => [node.id, [] as WorkflowDefinitionV2ControlEdge[]]),
  );
  for (const edge of definition.edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    forward.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge);
  }
  const reachability = new Map(
    definition.nodes.map((node) => [node.id, reachableFrom(node.id, forward)]),
  );
  const cyclicNodeIds = stronglyConnectedNodeIds(definition);
  const formulas = activationFormulas(definition, nodeById, cyclicNodeIds);
  const triggers = definition.nodes.filter((node) => isTriggerBlockType(node.type));
  const contracts = new Map(
    definition.nodes.map((node) => [
      node.id,
      contractForNode(node, registryContext),
    ]),
  );
  const targetsByNode = new Map<string, InputTarget[]>();
  for (const [nodeIndex, node] of definition.nodes.entries()) {
    targetsByNode.set(
      node.id,
      inputTargets(node, nodeIndex, contracts.get(node.id)!, issues),
    );
  }

  const availableValuesByNode: WorkflowAvailableValuesByNode = {};
  for (const consumer of definition.nodes) {
    const targets = targetsByNode.get(consumer.id) ?? [];
    const values: WorkflowAvailableValue[] = [];
    const activeTriggerIds = reachingTriggerIds(
      consumer.id,
      triggers,
      reachability,
    );

    if (activeTriggerIds.length > 0) {
      const triggerSchemas = activeTriggerIds
        .map((id) => contracts.get(id)?.output.bindingSchema)
        .filter((schema): schema is WorkflowValueSchema => schema !== undefined);
      const first = triggerSchemas[0];
      if (first && triggerSchemas.length === activeTriggerIds.length) {
        for (const candidate of requiredSchemaPaths(first)) {
          const schemas = triggerSchemas
            .map((schema) => requiredSchemaAtPath(schema, candidate.path))
            .filter((schema): schema is WorkflowValueSchema => schema !== null);
          if (schemas.length !== triggerSchemas.length) continue;
          const common = commonSourceSchema(schemas);
          if (!common) continue;
          const path = candidate.path.join(".");
          values.push({
            reference: `steps.entry.output.${path}`,
            label: `Active trigger · ${path}`,
            description: common.description ?? "Value supplied by every active trigger.",
            schema: workflowValueSchemaToJsonSchema(common),
            source: { kind: "entry", nodeId: null, blockType: null },
            guarantee: {
              kind: "active_entry",
              triggerNodeIds: activeTriggerIds,
              viaEdgeIds: [],
            },
            compatibleInputNames: targetCompatibility(common, targets),
          });
        }
      }
    }

    const consumerFormula = formulas.get(consumer.id) ?? emptyFormula();
    for (const source of definition.nodes) {
      if (
        source.id === consumer.id ||
        isTriggerBlockType(source.type) ||
        cyclicNodeIds.has(source.id) ||
        !reachability.get(source.id)?.has(consumer.id) ||
        !formulaImplies(consumerFormula, formulas.get(source.id) ?? emptyFormula())
      ) {
        continue;
      }
      const contract = contracts.get(source.id)!;
      const triggerNodeIds = [
        ...new Set(
          [...consumerFormula.terms.values()]
            .map((term) => term.get(TRIGGER_GUARD))
            .filter((id): id is string => id !== undefined),
        ),
      ].sort();
      const viaEdgeIds = causalEdgeIds(
        source.id,
        consumer.id,
        definition,
        reachability,
      );
      const guaranteeKind =
        (incoming.get(consumer.id)?.length ?? 0) > 1
          ? "join"
          : "unconditional_activation";
      for (const candidate of requiredSchemaPaths(contract.output.bindingSchema)) {
        const path = candidate.path.join(".");
        values.push({
          reference: `steps.${source.id}.output.${path}`,
          label: `${source.name ?? contract.presentation.label} · ${path}`,
          description: candidate.schema.description ?? contract.presentation.description,
          schema: workflowValueSchemaToJsonSchema(candidate.schema),
          source: {
            kind: "step",
            nodeId: source.id,
            blockType: source.type,
          },
          guarantee: {
            kind: guaranteeKind,
            triggerNodeIds,
            viaEdgeIds,
          },
          compatibleInputNames: targetCompatibility(candidate.schema, targets),
        });
      }
    }

    for (const candidate of requiredSchemaPaths(RUN_BINDING_SCHEMA)) {
      const path = candidate.path.join(".");
      values.push({
        reference: `run.${path}`,
        label: `Run · ${path}`,
        description: candidate.schema.description ?? "Value fixed for this workflow run.",
        schema: workflowValueSchemaToJsonSchema(candidate.schema),
        source: { kind: "run", nodeId: null, blockType: null },
        guarantee: {
          kind: "unconditional_activation",
          triggerNodeIds: activeTriggerIds,
          viaEdgeIds: [],
        },
        compatibleInputNames: targetCompatibility(candidate.schema, targets),
      });
    }
    availableValuesByNode[consumer.id] = values;
  }

  validateBindings(definition, targetsByNode, availableValuesByNode, issues);
  return {
    availableValuesByNode,
    nodeContracts: Object.fromEntries(contracts),
    issues,
  };
}
