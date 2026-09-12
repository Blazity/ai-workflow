/**
 * Which values every block of a definition may read, and the contracts that
 * decide it.
 *
 * One walk answers all of it (`analyzeWorkflowValues`): the per-node contracts,
 * the offered values, the binding issues and, on first read, the editor's data
 * catalog. Two things it needs are parameters rather than imports: the block
 * contract resolver, because availability follows from the deployment's
 * environment and model catalog, and the JSON Schema support, because ajv stays
 * in the worker.
 */
import {
  BLOCK_TYPE_SPECS,
  isSafeWorkflowInputName,
  isTriggerBlockType,
  isWorkflowAddressablePathSegment,
  type JsonSchema202012,
  type JsonValue,
  type TransformConfiguration,
  type WorkflowBranchConfigurationV2,
  type WorkflowBlockContract,
  type WorkflowBlockContractResolver,
  type WorkflowDataCatalogEntry,
  type WorkflowDataCatalogPresence,
  type WorkflowDefinitionCatalogResponse,
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
  isWorkflowSchemaAssignable,
  RUN_BINDING_SCHEMA,
} from "./bindings";
import type { WorkflowJsonSchemaSupport } from "./json-schema-support";
import { deriveTransformOutputSchema } from "./transform";
import { parseWorkflowDataReferenceV2 } from "./v2-bindings";

const MAX_ACTIVATION_TERMS = 256;
const TRIGGER_GUARD = "$trigger";

export interface WorkflowV2BindingAnalysis {
  availableValuesByNode: WorkflowAvailableValuesByNode;
  nodeContracts: Record<string, WorkflowBlockContract>;
  issues: WorkflowDefinitionValidationIssue[];
}

/**
 * One walk of one definition, shared by every reader below.
 *
 * Deciding which values a block may read means walking the graph, resolving a
 * contract per node and building the offered catalog; the bindings reader and
 * the data-catalog reader used to do all of that separately, so a request that
 * validated a draft, asked for its available values and then checked prompt
 * authoring walked the same graph five times. The walk happens here once and
 * every reader takes the result as a parameter.
 */
export interface WorkflowValueAnalysis extends WorkflowV2BindingAnalysis {
  /** The exact definition instance this pass walked. */
  definition: WorkflowDefinitionV2;
  /** The editor's data catalog, built on first read: a validation request
   *  never asks for it. */
  catalog(): WorkflowDefinitionCatalogResponse;
}

/** Analyses one definition against the block data one request works from. */
export type WorkflowValueAnalyzer = (
  definition: WorkflowDefinitionV2,
) => WorkflowValueAnalysis;

/**
 * What the walk found, kept private to this file: the catalog reader below is
 * its only consumer, and publishing it would put this module's internal maps
 * into the package's public interface.
 */
interface WorkflowValueWalk {
  definition: WorkflowDefinitionV2;
  /** Every node of the definition, by id. */
  nodeById: ReadonlyMap<string, WorkflowDefinitionV2Node>;
  /** Control edges arriving at a node; more than one means a join. */
  incoming: ReadonlyMap<string, readonly WorkflowDefinitionV2ControlEdge[]>;
  /** Which nodes each node reaches along control edges. */
  reachability: ReadonlyMap<string, ReadonlySet<string>>;
  /** Nodes inside a cycle, whose output is never guaranteed downstream. */
  cyclicNodeIds: ReadonlySet<string>;
  /** The Loop region a node belongs to, when it belongs to one. */
  loopRegionsByNodeId: ReadonlyMap<string, AuthoringLoopRegion>;
  /** When each node runs, as a formula over branch outcomes. */
  formulas: ReadonlyMap<string, ActivationFormula>;
  /** The contract resolved for each node, from its type and its own params. */
  contracts: ReadonlyMap<string, WorkflowBlockContract>;
  /** The inputs each node offers a binding for. */
  targetsByNode: ReadonlyMap<string, readonly InputTarget[]>;
  /** Triggers that can start a run reaching each node. */
  activeTriggerIdsByNode: ReadonlyMap<string, readonly string[]>;
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
  resolveContract: WorkflowBlockContractResolver,
  jsonSchema: WorkflowJsonSchemaSupport,
  referenceSchemas: TransformDefinitionReferenceSchemas = {},
): WorkflowBlockContract {
  const contract = resolveContract(node.type, configurationParams(node));
  if (node.type === "loop") {
    const carries = Array.isArray(node.configuration.carry)
      ? node.configuration.carry
      : [];
    const properties: Record<string, WorkflowValueSchema> = {};
    for (const carry of carries) {
      if (
        carry === null ||
        Array.isArray(carry) ||
        typeof carry !== "object" ||
        typeof carry.name !== "string" ||
        carry.schema === null ||
        Array.isArray(carry.schema) ||
        typeof carry.schema !== "object"
      ) {
        continue;
      }
      const inspected = jsonSchema.inspect(
        carry.schema as JsonSchema202012,
      );
      if (inspected.ok) properties[carry.name] = inspected.valueSchema;
    }
    if (contract.output.bindingSchema.type !== "object") return contract;
    const values: WorkflowValueSchema = {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
    const output = {
      ...contract.output.bindingSchema,
      properties: {
        ...contract.output.bindingSchema.properties,
        values,
      },
      required: [
        ...new Set([
          ...contract.output.bindingSchema.required,
          "values",
        ]),
      ],
    } satisfies WorkflowValueSchema;
    return {
      ...contract,
      output: {
        ...contract.output,
        schema: output,
        bindingSchema: output,
      },
    };
  }
  if (node.type !== "transform") return contract;

  const derived = deriveTransformOutputSchema(
    {
      configuration: node.configuration as unknown as TransformConfiguration,
      referenceSchemas,
    },
    jsonSchema,
  );
  if (!derived) return contract;
  const inspected = jsonSchema.inspect(derived, {
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

type TransformDefinitionReferenceSchemas = NonNullable<
  Parameters<typeof deriveTransformOutputSchema>[0]["referenceSchemas"]
>;

function schemaAtPath(
  schema: WorkflowValueSchema,
  path: readonly string[],
): { schema: WorkflowValueSchema; required: boolean } | null {
  let current = schema;
  let required = true;
  for (const segment of path) {
    const unwrapped = nullableSchema(current).schema;
    if (unwrapped.type !== "object") return null;
    const child = unwrapped.properties[segment];
    if (!child) return null;
    required = required && unwrapped.required.includes(segment);
    current = child;
  }
  return { schema: current, required };
}

function transformReferenceSchemas(
  node: WorkflowDefinitionV2Node,
  definition: WorkflowDefinitionV2,
  contracts: ReadonlyMap<string, WorkflowBlockContract>,
): TransformDefinitionReferenceSchemas {
  if (node.type !== "transform") return {};
  const config = node.configuration as unknown as TransformConfiguration;
  const references =
    config.operation === "format_text"
      ? []
      : config.operation === "build_object"
        ? config.fields.flatMap((field) =>
            field.value.kind === "reference" ? [field.value.reference] : [],
          )
        : [config.source];
  const result: Record<
    string,
    { schema: JsonSchema202012; required: boolean }
  > = {};
  for (const reference of references) {
    const parsed = parseWorkflowDataReferenceV2(reference);
    let source: WorkflowValueSchema | null = null;
    if (parsed?.root === "steps") {
      source = contracts.get(parsed.nodeId)?.output.bindingSchema ?? null;
    } else if (parsed?.root === "entry") {
      const triggerSchemas = definition.nodes
        .filter((candidate) => isTriggerBlockType(candidate.type))
        .map((candidate) => contracts.get(candidate.id)?.output.bindingSchema)
        .filter(
          (candidate): candidate is WorkflowValueSchema =>
            candidate !== undefined,
        );
      source =
        triggerSchemas.length > 0 ? commonSourceSchema(triggerSchemas) : null;
    } else if (parsed?.root === "run") {
      source = v2RunBindingSchema(
        definition,
        definition.nodes
          .filter((candidate) => isTriggerBlockType(candidate.type))
          .map((candidate) => candidate.id),
      );
    }
    if (!source || !parsed) continue;
    const resolved = schemaAtPath(source, parsed.path);
    if (!resolved) continue;
    result[reference] = {
      schema: workflowValueSchemaToJsonSchema(resolved.schema),
      required: resolved.required,
    };
  }
  return result;
}

function contractsForDefinition(
  definition: WorkflowDefinitionV2,
  resolveContract: WorkflowBlockContractResolver,
  jsonSchema: WorkflowJsonSchemaSupport,
): Map<string, WorkflowBlockContract> {
  const contracts = new Map(
    definition.nodes.map((node) => [
      node.id,
      resolveContract(node.type, configurationParams(node)),
    ]),
  );
  for (let pass = 0; pass < definition.nodes.length; pass += 1) {
    for (const node of definition.nodes) {
      if (node.type !== "transform" && node.type !== "loop") continue;
      contracts.set(
        node.id,
        contractForNode(
          node,
          resolveContract,
          jsonSchema,
          transformReferenceSchemas(node, definition, contracts),
        ),
      );
    }
  }
  return contracts;
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
function workflowValueSchemaToJsonSchema(
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
    result.push({ path, schema: child }, ...requiredSchemaPaths(child, path));
  }
  return result;
}

interface CatalogSchemaPath {
  path: string[];
  schema: WorkflowValueSchema;
  presence: WorkflowDataCatalogPresence;
}

function nullableSchema(schema: WorkflowValueSchema): {
  schema: WorkflowValueSchema;
  nullable: boolean;
} {
  return schema.type === "nullable"
    ? { schema: schema.value, nullable: true }
    : { schema, nullable: schema.type === "null" };
}

function catalogPresence(
  optional: boolean,
  nullable: boolean,
): WorkflowDataCatalogPresence {
  if (optional && nullable) return "optional_nullable";
  if (optional) return "optional";
  if (nullable) return "nullable";
  return "required";
}

function catalogSchemaPaths(
  schema: WorkflowValueSchema,
  prefix: string[] = [],
  parentOptional = false,
): CatalogSchemaPath[] {
  const unwrapped = nullableSchema(schema);
  if (unwrapped.schema.type !== "object") return [];
  const result: CatalogSchemaPath[] = [];
  for (const [name, child] of Object.entries(unwrapped.schema.properties)) {
    if (!isWorkflowAddressablePathSegment(name)) continue;
    const optional =
      parentOptional || !unwrapped.schema.required.includes(name);
    const childUnwrapped = nullableSchema(child);
    const path = [...prefix, name];
    result.push({
      path,
      schema: child,
      presence: catalogPresence(optional, childUnwrapped.nullable),
    }, ...catalogSchemaPaths(child, path, optional));
  }
  return result;
}

function authoredExample(schema: JsonSchema202012): JsonValue | undefined {
  const record = schema as Record<string, unknown>;
  const candidate =
    record.example ??
    record.default ??
    (Array.isArray(record.examples) ? record.examples[0] : undefined);
  return candidate === null ||
    typeof candidate === "string" ||
    typeof candidate === "number" ||
    typeof candidate === "boolean" ||
    Array.isArray(candidate) ||
    (candidate !== null && typeof candidate === "object")
    ? (candidate as JsonValue)
    : undefined;
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
    const guarded = new Map([...term, [variable, value]]);
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

function stronglyConnectedComponents(
  definition: WorkflowDefinitionV2,
): string[][] {
  const adjacency = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) {
    if (!adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }

  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const components: string[][] = [];

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
    components.push(component);
  };

  for (const node of definition.nodes) {
    if (!indexById.has(node.id)) visit(node.id);
  }
  return components;
}

function stronglyConnectedNodeIds(definition: WorkflowDefinitionV2): Set<string> {
  const selfLoops = new Set(
    definition.edges
      .filter((edge) => edge.from === edge.to)
      .map((edge) => edge.from),
  );
  return new Set(
    stronglyConnectedComponents(definition).flatMap((component) =>
      component.length > 1 || selfLoops.has(component[0]!)
        ? component
        : [],
    ),
  );
}

interface AuthoringLoopRegion {
  loopNodeId: string;
  memberNodeIds: ReadonlySet<string>;
  initialEntryNodeIds: string[];
  retryEntryNodeIds: string[];
  phaseAdjacency: ReadonlyMap<string, readonly string[]>;
  phaseGuaranteedAdjacency: ReadonlyMap<string, readonly string[]>;
  initialGraphAdjacency: ReadonlyMap<string, readonly string[]>;
  triggerNodeIds: string[];
}

function authoringLoopRegions(
  definition: WorkflowDefinitionV2,
  nodeById: ReadonlyMap<string, WorkflowDefinitionV2Node>,
): Map<string, AuthoringLoopRegion> {
  const result = new Map<string, AuthoringLoopRegion>();
  for (const component of stronglyConnectedComponents(definition)) {
    const members = new Set(component);
    const loops = component.filter((id) => nodeById.get(id)?.type === "loop");
    if (loops.length !== 1) continue;
    const loopNodeId = loops[0]!;
    const initialEntryNodeIds = [
      ...new Set(
        definition.edges
          .filter(
            (edge) =>
              !members.has(edge.from) &&
              members.has(edge.to) &&
              edge.to !== loopNodeId,
          )
          .map((edge) => edge.to),
      ),
    ];
    const retryEntryNodeIds = [
      ...new Set(
        definition.edges
          .filter(
            (edge) =>
              edge.from === loopNodeId &&
              edge.fromPort === "continue" &&
              members.has(edge.to),
          )
          .map((edge) => edge.to),
      ),
    ];
    const phaseAdjacency = new Map(
      component.map((nodeId) => [nodeId, [] as string[]]),
    );
    const phaseGuaranteedAdjacency = new Map(
      component.map((nodeId) => [nodeId, [] as string[]]),
    );
    const initialGraphAdjacency = new Map(
      definition.nodes.map((node) => [node.id, [] as string[]]),
    );
    for (const edge of definition.edges) {
      if (edge.from !== loopNodeId) {
        initialGraphAdjacency.get(edge.from)?.push(edge.to);
      }
      if (
        edge.from === loopNodeId ||
        !members.has(edge.from) ||
        !members.has(edge.to)
      ) {
        continue;
      }
      phaseAdjacency.get(edge.from)?.push(edge.to);
      const source = nodeById.get(edge.from);
      if (
        source &&
        BLOCK_TYPE_SPECS[source.type].ports.length === 1
      ) {
        phaseGuaranteedAdjacency.get(edge.from)?.push(edge.to);
      }
    }
    const region = {
      loopNodeId,
      memberNodeIds: members,
      initialEntryNodeIds,
      retryEntryNodeIds,
      phaseAdjacency,
      phaseGuaranteedAdjacency,
      initialGraphAdjacency,
      triggerNodeIds: definition.nodes
        .filter((node) => isTriggerBlockType(node.type))
        .map((node) => node.id),
    };
    for (const member of component) result.set(member, region);
  }
  return result;
}

function reachableFromStarts(
  starts: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  blockedNodeId?: string,
): Set<string> {
  const reached = new Set<string>();
  const queue = starts.filter((nodeId) => nodeId !== blockedNodeId);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (reached.has(current)) continue;
    reached.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (next !== blockedNodeId) queue.push(next);
    }
  }
  return reached;
}

function phaseGuaranteesSource(
  sourceId: string,
  consumerId: string,
  starts: readonly string[],
  phase: "initial" | "retry",
  region: AuthoringLoopRegion,
): boolean | null {
  const reachable = reachableFromStarts(starts, region.phaseAdjacency);
  if (!reachable.has(consumerId)) return null;
  if (sourceId === region.loopNodeId) return phase === "retry";
  if (!reachable.has(sourceId)) return false;
  const guaranteed = reachableFromStarts(
    starts,
    region.phaseGuaranteedAdjacency,
  );
  if (
    guaranteed.has(sourceId) &&
    reachableFromStarts([sourceId], region.phaseAdjacency).has(consumerId)
  ) {
    return true;
  }
  return !reachableFromStarts(
    starts,
    region.phaseAdjacency,
    sourceId,
  ).has(consumerId);
}

function loopScopedGuarantee(
  sourceId: string,
  consumerId: string,
  regionsByNodeId: ReadonlyMap<string, AuthoringLoopRegion>,
): boolean | null {
  const sourceRegion = regionsByNodeId.get(sourceId);
  if (
    sourceRegion?.loopNodeId === sourceId &&
    !regionsByNodeId.has(consumerId)
  ) {
    // The owner scope materializes the Loop output when a child exits through
    // either a boundary or exhaustion. Downstream nodes outside the cycle may
    // therefore consume its carried values without falling back to a stale
    // child step output.
    return true;
  }
  const region = regionsByNodeId.get(consumerId);
  if (!region) return null;
  if (!region.memberNodeIds.has(sourceId)) {
    if (region.initialEntryNodeIds.length === 0) return false;
    const reachable = reachableFromStarts(
      region.triggerNodeIds,
      region.initialGraphAdjacency,
    );
    if (
      !reachable.has(sourceId) ||
      region.initialEntryNodeIds.some((entryId) => !reachable.has(entryId))
    ) {
      return false;
    }
    const withoutSource = reachableFromStarts(
      region.triggerNodeIds,
      region.initialGraphAdjacency,
      sourceId,
    );
    return region.initialEntryNodeIds.every(
      (entryId) => !withoutSource.has(entryId),
    );
  }
  const phases = [
    phaseGuaranteesSource(
      sourceId,
      consumerId,
      region.initialEntryNodeIds,
      "initial",
      region,
    ),
    phaseGuaranteesSource(
      sourceId,
      consumerId,
      region.retryEntryNodeIds,
      "retry",
      region,
    ),
  ].filter((value): value is boolean => value !== null);
  return phases.length > 0 && phases.every(Boolean);
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

type StaticBoolean = true | false | "unknown";

function staticBranchOutcomeForTrigger(
  configuration: Readonly<Record<string, JsonValue>>,
  trigger: WorkflowDefinitionV2Node,
): StaticBoolean {
  if (
    (configuration.combinator !== "all" &&
      configuration.combinator !== "any") ||
    !Array.isArray(configuration.conditions)
  ) {
    return "unknown";
  }
  const parsed = configuration as unknown as WorkflowBranchConfigurationV2;
  const values = parsed.conditions.map((condition): StaticBoolean => {
    const actual =
      condition.reference === "run.trigger.id"
        ? trigger.id
        : condition.reference === "run.trigger.type"
          ? trigger.type
          : undefined;
    if (
      actual === undefined ||
      (condition.operator !== "equals" &&
        condition.operator !== "not_equals") ||
      typeof condition.value !== "string"
    ) {
      return "unknown";
    }
    const equal = actual === condition.value;
    return condition.operator === "equals" ? equal : !equal;
  });
  if (parsed.combinator === "all") {
    if (values.includes(false)) return false;
    return values.every((value) => value === true) ? true : "unknown";
  }
  if (values.includes(true)) return true;
  return values.every((value) => value === false) ? false : "unknown";
}

function triggerCanReachConsumer(
  trigger: WorkflowDefinitionV2Node,
  consumerId: string,
  definition: WorkflowDefinitionV2,
  nodeById: ReadonlyMap<string, WorkflowDefinitionV2Node>,
): boolean {
  const visited = new Set<string>();
  const queue = [trigger.id];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current === consumerId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodeById.get(current);
    const outcome =
      node?.type === "branch"
        ? staticBranchOutcomeForTrigger(node.configuration, trigger)
        : "unknown";
    for (const edge of definition.edges) {
      if (edge.from !== current) continue;
      if (
        node?.type === "branch" &&
        outcome !== "unknown" &&
        edge.fromPort !== String(outcome)
      ) {
        continue;
      }
      queue.push(edge.to);
    }
  }
  return false;
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

function arrayItemSchema(
  schema: WorkflowValueSchema,
): WorkflowValueSchema | null {
  const unwrapped = nullableSchema(schema).schema;
  return unwrapped.type === "array" ? unwrapped.items : null;
}

function targetListCompatibility(
  source: WorkflowValueSchema,
  targets: readonly InputTarget[],
): string[] {
  return targets
    .filter((target) => {
      const itemSchema = arrayItemSchema(target.schema);
      return (
        itemSchema !== null &&
        isWorkflowSchemaAssignable(source, itemSchema)
      );
    })
    .map((target) => target.name);
}

function inputTargets(
  node: WorkflowDefinitionV2Node,
  nodeIndex: number,
  contract: WorkflowBlockContract,
  issues: WorkflowDefinitionValidationIssue[],
  jsonSchema: WorkflowJsonSchemaSupport,
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
    const parsed = jsonSchema.inspect(input.schema);
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
  if (node.type === "loop" && Array.isArray(node.configuration.carry)) {
    const seenCarry = new Set<string>();
    for (const [carryIndex, rawCarry] of node.configuration.carry.entries()) {
      const basePath = `/nodes/${nodeIndex}/configuration/carry/${carryIndex}`;
      if (
        rawCarry === null ||
        Array.isArray(rawCarry) ||
        typeof rawCarry !== "object" ||
        typeof rawCarry.name !== "string" ||
        rawCarry.schema === null ||
        Array.isArray(rawCarry.schema) ||
        typeof rawCarry.schema !== "object" ||
        rawCarry.binding === null ||
        Array.isArray(rawCarry.binding) ||
        typeof rawCarry.binding !== "object"
      ) {
        continue;
      }
      if (
        !isSafeWorkflowInputName(rawCarry.name) ||
        seenCarry.has(rawCarry.name)
      ) {
        issues.push({
          code: "loop.carry_name",
          severity: "error",
          nodeId: node.id,
          path: `${basePath}/name`,
          message: `Loop "${node.id}" has invalid or duplicate carried value "${rawCarry.name}".`,
        });
        continue;
      }
      seenCarry.add(rawCarry.name);
      const parsed = jsonSchema.inspect(
        rawCarry.schema as JsonSchema202012,
      );
      if (!parsed.ok) {
        for (const issue of parsed.issues) {
          issues.push({
            code: `loop.carry_schema.${issue.code}`,
            severity: "error",
            nodeId: node.id,
            path: `${basePath}/schema${issue.path}`,
            message: issue.message.replace(
              /^outputSchema/,
              `Carried value "${rawCarry.name}" schema`,
            ),
          });
        }
        continue;
      }
      targets.push({
        name: `carry.${rawCarry.name}`,
        schema: parsed.valueSchema,
        required: true,
        binding: rawCarry.binding as WorkflowInputBindingV2,
        path: `${basePath}/binding`,
      });
    }
  }
  return targets;
}

function validateLiteral(
  target: InputTarget,
  value: JsonValue,
  jsonSchema: WorkflowJsonSchemaSupport,
): Array<{ path: string; message: string }> {
  if (target.schema.type === "unknown") return [];
  return jsonSchema.validateValue(
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
  jsonSchema: WorkflowJsonSchemaSupport,
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
        for (const issue of validateLiteral(
          target,
          target.binding.value,
          jsonSchema,
        )) {
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
      if (target.binding.kind === "reference_list") {
        const itemSchema = arrayItemSchema(target.schema);
        if (!itemSchema) {
          issues.push({
            code: "binding.reference_list_destination",
            severity: "error",
            nodeId: node.id,
            path: target.path,
            message: `Block "${node.id}" input "${target.name}" accepts a reference list only when its schema is an array.`,
          });
          continue;
        }
        for (const [referenceIndex, reference] of target.binding.references.entries()) {
          const available = availableByReference.get(reference);
          const parsedSource = available
            ? jsonSchema.inspect(available.schema)
            : null;
          if (!available) {
            issues.push({
              code: "binding.unavailable_reference",
              severity: "error",
              nodeId: node.id,
              path: `${target.path}/references/${referenceIndex}`,
              message: `Block "${node.id}" input "${target.name}" references "${reference}", which is not guaranteed when the block runs.`,
            });
          } else if (
            !parsedSource?.ok ||
            !isWorkflowSchemaAssignable(
              parsedSource.valueSchema,
              itemSchema,
            )
          ) {
            issues.push({
              code: "binding.reference_type",
              severity: "error",
              nodeId: node.id,
              path: `${target.path}/references/${referenceIndex}`,
              message: `Block "${node.id}" input "${target.name}" cannot include "${reference}" because it is incompatible with the array item type.`,
            });
          }
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

/**
 * Walks one definition once: the graph, a contract per node, and the values
 * every node may read. Readers take the result: its own fields for the
 * bindings, `analyzeWorkflowV2Catalog` for the editor's data catalog. Nothing
 * below walks the graph a second time.
 */
export function analyzeWorkflowValues(
  definition: WorkflowDefinitionV2,
  resolveContract: WorkflowBlockContractResolver,
  jsonSchema: WorkflowJsonSchemaSupport,
): WorkflowValueAnalysis {
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
  const loopRegionsByNodeId = authoringLoopRegions(definition, nodeById);
  const formulas = activationFormulas(definition, nodeById, cyclicNodeIds);
  const triggers = definition.nodes.filter((node) => isTriggerBlockType(node.type));
  const contracts = contractsForDefinition(definition, resolveContract, jsonSchema);
  const targetsByNode = new Map<string, InputTarget[]>();
  for (const [nodeIndex, node] of definition.nodes.entries()) {
    targetsByNode.set(
      node.id,
      inputTargets(node, nodeIndex, contracts.get(node.id)!, issues, jsonSchema),
    );
  }

  const activeTriggerIdsByNode = new Map<string, readonly string[]>(
    definition.nodes.map((consumer) => [
      consumer.id,
      reachingTriggerIds(consumer.id, triggers, reachability).filter(
        (triggerId) => {
          const trigger = nodeById.get(triggerId);
          return (
            trigger !== undefined &&
            triggerCanReachConsumer(trigger, consumer.id, definition, nodeById)
          );
        },
      ),
    ]),
  );

  const availableValuesByNode: WorkflowAvailableValuesByNode = {};
  for (const consumer of definition.nodes) {
    const targets = targetsByNode.get(consumer.id) ?? [];
    const values: WorkflowAvailableValue[] = [];
    const activeTriggerIds = activeTriggerIdsByNode.get(consumer.id) ?? [];

    if (activeTriggerIds.length > 0) {
      const triggerSchemas = activeTriggerIds
        .map((id) => contracts.get(id)?.output.bindingSchema)
        .filter((schema): schema is WorkflowValueSchema => schema !== undefined);
      const first = triggerSchemas[0];
      if (first && triggerSchemas.length === activeTriggerIds.length) {
        const commonOutput = commonSourceSchema(triggerSchemas);
        if (commonOutput) {
          values.push({
            reference: "steps.entry.output",
            label:
              activeTriggerIds.length === 1
                ? `${nodeById.get(activeTriggerIds[0]!)?.name ?? contracts.get(activeTriggerIds[0]!)?.presentation.label ?? "Trigger"} · output`
                : "Trigger that started this run · output",
            description: "Complete output from the trigger that started this run.",
            schema: workflowValueSchemaToJsonSchema(commonOutput),
            source: { kind: "entry", nodeId: null, blockType: null },
            guarantee: {
              kind: "active_entry",
              triggerNodeIds: [...activeTriggerIds],
              viaEdgeIds: [],
            },
            compatibleInputNames: targetCompatibility(commonOutput, targets),
          });
        }
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
              triggerNodeIds: [...activeTriggerIds],
              viaEdgeIds: [],
            },
            compatibleInputNames: targetCompatibility(common, targets),
          });
        }
      }
    }

    const consumerFormula = formulas.get(consumer.id) ?? emptyFormula();
    for (const source of definition.nodes) {
      const scopedGuarantee = loopScopedGuarantee(
        source.id,
        consumer.id,
        loopRegionsByNodeId,
      );
      const directSolePredecessor =
        (incoming.get(consumer.id)?.length ?? 0) > 0 &&
        incoming.get(consumer.id)?.every((edge) => edge.from === source.id);
      if (
        source.id === consumer.id ||
        isTriggerBlockType(source.type) ||
        !reachability.get(source.id)?.has(consumer.id) ||
        !(
          scopedGuarantee ??
          (directSolePredecessor ||
          (
            !cyclicNodeIds.has(source.id) &&
            formulaImplies(
              consumerFormula,
              formulas.get(source.id) ?? emptyFormula(),
            )
          ))
        )
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
      values.push({
        reference: `steps.${source.id}.output`,
        label: `${source.name ?? contract.presentation.label} · output`,
        description: contract.presentation.description,
        schema: workflowValueSchemaToJsonSchema(contract.output.bindingSchema),
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
        compatibleInputNames: targetCompatibility(
          contract.output.bindingSchema,
          targets,
        ),
      });
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

    for (const candidate of requiredSchemaPaths(
      v2RunBindingSchema(definition, activeTriggerIds),
    )) {
      const path = candidate.path.join(".");
      values.push({
        reference: `run.${path}`,
        label: `Run · ${path}`,
        description: candidate.schema.description ?? "Value fixed for this workflow run.",
        schema: workflowValueSchemaToJsonSchema(candidate.schema),
        source: { kind: "run", nodeId: null, blockType: null },
        guarantee: {
          kind: "unconditional_activation",
          triggerNodeIds: [...activeTriggerIds],
          viaEdgeIds: [],
        },
        compatibleInputNames: targetCompatibility(candidate.schema, targets),
      });
    }
    availableValuesByNode[consumer.id] = values;
  }

  validateBindings(
    definition,
    targetsByNode,
    availableValuesByNode,
    issues,
    jsonSchema,
  );
  const nodeContracts = Object.fromEntries(contracts);
  const walk: WorkflowValueWalk = {
    definition,
    nodeById,
    incoming,
    reachability,
    cyclicNodeIds,
    loopRegionsByNodeId,
    formulas,
    contracts,
    targetsByNode,
    activeTriggerIdsByNode,
  };
  let catalog: WorkflowDefinitionCatalogResponse | null = null;
  return {
    definition,
    availableValuesByNode,
    nodeContracts,
    issues,
    catalog: () => (catalog ??= { nodeContracts, catalogByNode: catalogByNode(walk) }),
  };
}

function v2RunBindingSchema(
  definition: WorkflowDefinitionV2,
  activeTriggerIds?: readonly string[],
): WorkflowValueSchema {
  const triggers = definition.nodes.filter((node) =>
    isTriggerBlockType(node.type) &&
    (activeTriggerIds === undefined || activeTriggerIds.includes(node.id)),
  );
  return {
    type: "object",
    properties: {
      ...(
        RUN_BINDING_SCHEMA.type === "object"
          ? RUN_BINDING_SCHEMA.properties
          : {}
      ),
      trigger: {
        type: "object",
        properties: {
          id: {
            type: "string",
            enum: triggers.map((trigger) => trigger.id),
            description: "Trigger block that started this run.",
          },
          type: {
            type: "string",
            enum: [...new Set(triggers.map((trigger) => trigger.type))],
            description: "Type of trigger that started this run.",
          },
        },
        required: ["id", "type"],
        additionalProperties: false,
      },
    },
    required: [
      ...(
        RUN_BINDING_SCHEMA.type === "object"
          ? RUN_BINDING_SCHEMA.required
          : []
      ),
      "trigger",
    ],
    additionalProperties: false,
  };
}

function catalogEntry(
  input: Omit<WorkflowDataCatalogEntry, "schema" | "example"> & {
    valueSchema: WorkflowValueSchema;
  },
): WorkflowDataCatalogEntry {
  const schema = workflowValueSchemaToJsonSchema(input.valueSchema);
  const example = authoredExample(schema);
  return {
    reference: input.reference,
    label: input.label,
    description: input.description,
    schema,
    source: input.source,
    presence: input.presence,
    availability: input.availability,
    compatibleInputNames: input.compatibleInputNames,
    compatibleListInputNames: input.compatibleListInputNames,
    ...(example === undefined ? {} : { example }),
  };
}

/**
 * The editor's structural data catalog, read off the analysis pass without
 * running prompt/profile authoring checks. Incomplete drafts are expected:
 * unavailable values remain visible with an explanation instead of becoming
 * request failures.
 */
function catalogByNode(
  walk: WorkflowValueWalk,
): Record<string, WorkflowDataCatalogEntry[]> {
  const {
    definition,
    nodeById,
    incoming,
    reachability,
    cyclicNodeIds,
    loopRegionsByNodeId,
    formulas,
    contracts,
    targetsByNode,
    activeTriggerIdsByNode,
  } = walk;

  const byNode: Record<string, WorkflowDataCatalogEntry[]> = {};
  for (const consumer of definition.nodes) {
    const targets = targetsByNode.get(consumer.id) ?? [];
    const entries: WorkflowDataCatalogEntry[] = [];
    const activeTriggerIds = activeTriggerIdsByNode.get(consumer.id) ?? [];
    const triggerSchemas = activeTriggerIds
      .map((id) => contracts.get(id)?.output.bindingSchema)
      .filter((schema): schema is WorkflowValueSchema => schema !== undefined);
    const commonTriggerOutput =
      triggerSchemas.length === activeTriggerIds.length
        ? commonSourceSchema(triggerSchemas)
        : null;
    const triggerLabel =
      activeTriggerIds.length === 1
        ? nodeById.get(activeTriggerIds[0]!)?.name ??
          contracts.get(activeTriggerIds[0]!)?.presentation.label ??
          "Trigger"
        : "Trigger that started this run";

    if (commonTriggerOutput) {
      entries.push(
        catalogEntry({
          reference: "steps.entry.output",
          label: `${triggerLabel} · Entire output`,
          description: "Complete output from the trigger that started this run.",
          valueSchema: commonTriggerOutput,
          source: {
            kind: "trigger",
            ...(activeTriggerIds.length === 1
              ? { nodeId: activeTriggerIds[0] }
              : {}),
          },
          presence: catalogPresence(
            false,
            nullableSchema(commonTriggerOutput).nullable,
          ),
          availability: {
            state: "available",
            guarantee: "The active trigger always supplies this output.",
          },
          compatibleInputNames: targetCompatibility(
            commonTriggerOutput,
            targets,
          ),
          compatibleListInputNames: targetListCompatibility(
            commonTriggerOutput,
            targets,
          ),
        }),
      );
      for (const candidate of catalogSchemaPaths(commonTriggerOutput)) {
        const path = candidate.path.join(".");
        entries.push(
          catalogEntry({
            reference: `steps.entry.output.${path}`,
            label: `${triggerLabel} · ${path === "output" ? "Output" : path}`,
            description:
              candidate.schema.description ??
              "Value supplied by every possible trigger.",
            valueSchema: candidate.schema,
            source: {
              kind: "trigger",
              ...(activeTriggerIds.length === 1
                ? { nodeId: activeTriggerIds[0] }
                : {}),
            },
            presence: candidate.presence,
            availability: {
              state: "available",
              guarantee: "Every possible active trigger exposes this field.",
            },
            compatibleInputNames: targetCompatibility(
              candidate.schema,
              targets,
            ),
            compatibleListInputNames: targetListCompatibility(
              candidate.schema,
              targets,
            ),
          }),
        );
      }
    }

    const commonTriggerReferences = new Set(
      entries
        .filter((entry) => entry.source.kind === "trigger")
        .map((entry) => entry.reference),
    );
    const triggerSpecific = new Map<
      string,
      {
        path: string;
        schemas: WorkflowValueSchema[];
        triggerIds: string[];
        presence: WorkflowDataCatalogPresence;
      }
    >();
    for (const triggerId of activeTriggerIds) {
      const schema = contracts.get(triggerId)?.output.bindingSchema;
      if (!schema) continue;
      for (const candidate of catalogSchemaPaths(schema)) {
        const path = candidate.path.join(".");
        const reference =
          `steps.entry.output.${path}` as const;
        if (commonTriggerReferences.has(reference)) continue;
        const existing = triggerSpecific.get(reference);
        if (existing) {
          existing.schemas.push(candidate.schema);
          existing.triggerIds.push(triggerId);
        } else {
          triggerSpecific.set(reference, {
            path,
            schemas: [candidate.schema],
            triggerIds: [triggerId],
            presence: candidate.presence,
          });
        }
      }
    }
    for (const [reference, candidate] of triggerSpecific) {
      const schema = commonSourceSchema(candidate.schemas);
      if (!schema) continue;
      const names = candidate.triggerIds.map(
        (id) =>
          nodeById.get(id)?.name ??
          contracts.get(id)?.presentation.label ??
          id,
      );
      entries.push(
        catalogEntry({
          reference: reference as WorkflowDataCatalogEntry["reference"],
          label: `${triggerLabel} · ${candidate.path}`,
          description:
            schema.description ??
            `Only supplied by ${names.join(", ")}.`,
          valueSchema: schema,
          source: {
            kind: "trigger",
            ...(candidate.triggerIds.length === 1
              ? { nodeId: candidate.triggerIds[0] }
              : {}),
          },
          presence: candidate.presence,
          availability: {
            state: "unavailable",
            reason:
              `Only available when ${names.join(" or ")} starts the run. ` +
              "Branch on Run info → Trigger ID or Trigger type first.",
          },
          compatibleInputNames: targetCompatibility(schema, targets),
          compatibleListInputNames: targetListCompatibility(schema, targets),
        }),
      );
    }

    const consumerFormula = formulas.get(consumer.id) ?? emptyFormula();
    for (const source of definition.nodes) {
      if (
        source.id === consumer.id ||
        isTriggerBlockType(source.type) ||
        !reachability.get(source.id)?.has(consumer.id)
      ) {
        continue;
      }
      const contract = contracts.get(source.id)!;
      const guaranteed =
        loopScopedGuarantee(
          source.id,
          consumer.id,
          loopRegionsByNodeId,
        ) ??
        (
          !cyclicNodeIds.has(source.id) &&
          formulaImplies(
            consumerFormula,
            formulas.get(source.id) ?? emptyFormula(),
          )
        );
      const availability = guaranteed
        ? ({
            state: "available",
            guarantee:
              (incoming.get(consumer.id)?.length ?? 0) > 1
                ? "This value is guaranteed at the join."
                : "This step always runs before the current block.",
          } as const)
        : ({
            state: "unavailable",
            reason:
              "This step can be skipped on a path that reaches the current block.",
          } as const);
      const sourceDetails = {
        kind: "step" as const,
        nodeId: source.id,
      };
      entries.push(
        catalogEntry({
          reference: `steps.${source.id}.output`,
          label: `${source.name ?? contract.presentation.label} · Entire output`,
          description: contract.presentation.description,
          valueSchema: contract.output.bindingSchema,
          source: sourceDetails,
          presence: catalogPresence(
            false,
            nullableSchema(contract.output.bindingSchema).nullable,
          ),
          availability,
          compatibleInputNames: targetCompatibility(
            contract.output.bindingSchema,
            targets,
          ),
          compatibleListInputNames: targetListCompatibility(
            contract.output.bindingSchema,
            targets,
          ),
        }),
      );
      for (const candidate of catalogSchemaPaths(
        contract.output.bindingSchema,
      )) {
        const path = candidate.path.join(".");
        entries.push(
          catalogEntry({
            reference: `steps.${source.id}.output.${path}`,
            label: `${source.name ?? contract.presentation.label} · ${
              path === "output" ? "Output" : path
            }`,
            description:
              candidate.schema.description ??
              contract.presentation.description,
            valueSchema: candidate.schema,
            source: sourceDetails,
            presence: candidate.presence,
            availability,
            compatibleInputNames: targetCompatibility(
              candidate.schema,
              targets,
            ),
            compatibleListInputNames: targetListCompatibility(
              candidate.schema,
              targets,
            ),
          }),
        );
      }
    }

    for (const candidate of catalogSchemaPaths(
      v2RunBindingSchema(definition, activeTriggerIds),
    )) {
      const path = candidate.path.join(".");
      entries.push(
        catalogEntry({
          reference: `run.${path}`,
          label: `Run info · ${path}`,
          description:
            candidate.schema.description ??
            "Value fixed for this workflow run.",
          valueSchema: candidate.schema,
          source: { kind: "run" },
          presence: candidate.presence,
          availability: {
            state: "available",
            guarantee: "Run information is always available.",
          },
          compatibleInputNames: targetCompatibility(
            candidate.schema,
            targets,
          ),
          compatibleListInputNames: targetListCompatibility(
            candidate.schema,
            targets,
          ),
        }),
      );
    }
    byNode[consumer.id] = entries;
  }

  return byNode;
}

/** The editor's data catalog half of the analysis. */
export function analyzeWorkflowV2Catalog(
  analysis: WorkflowValueAnalysis,
): WorkflowDefinitionCatalogResponse {
  return analysis.catalog();
}

/**
 * The analyser one request works from, bound to the block contract resolver of
 * the same environment read (`services/workflow-definitions/block-contracts.ts`).
 *
 * It does not cache by definition instance: a request keeps to one pass by
 * handing the analysis it computed to the readers that need it, so a graph
 * edited between two validations is never answered from the earlier pass.
 */
export function createWorkflowValueAnalyzer(
  resolveContract: WorkflowBlockContractResolver,
  jsonSchema: WorkflowJsonSchemaSupport,
): WorkflowValueAnalyzer {
  return (definition) =>
    analyzeWorkflowValues(definition, resolveContract, jsonSchema);
}
