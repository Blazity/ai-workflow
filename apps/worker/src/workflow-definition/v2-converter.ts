import { createHash } from "node:crypto";
import {
  BLOCK_PARAM_KEYS,
  BLOCK_TYPE_SPECS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  FAILURE_PORT,
  builtinHarnessProfileReference,
  containsMalformedPromptReference,
  formatPromptReferenceToken,
  isTriggerBlockType,
  parsePromptReferenceTokens,
  type HarnessProfileReference,
  type HarnessProvider,
  type JsonSchema202012,
  type JsonValue,
  type ParsedPromptReference,
  type PromptReferenceSelector,
  type WorkflowAdditionalInputV2,
  type WorkflowBlockType,
  type WorkflowDataReferenceV2,
  type WorkflowDefinitionV1,
  type WorkflowDefinitionV2,
  type WorkflowDefinitionV2Node,
  type WorkflowInputBindingV2,
  type WorkflowValueSchema,
} from "@shared/contracts";
import { parseCondition, type ConditionAst } from "@shared/conditions";
import {
  buildWorkflowBindingGraphContext,
  parseWorkflowBindingSource,
  resolveRequiredWorkflowSchemaPath,
  RUN_BINDING_SCHEMA,
  validateWorkflowBindingIssues,
  type WorkflowBindingGraphContext,
} from "./bindings.js";
import {
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";
import {
  isWorkflowDataReferenceV2,
  validateWorkflowDefinitionIssuesForDeployment,
} from "./schema.js";
import { VARIABLE_PARAM_KEYS } from "../workflows/prompt-vars.js";

const CONVERTER_VERSION = 1;
const PROMPT_VARIABLE_PATTERN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const ANY_PLACEHOLDER_PATTERN = /\{\{([^{}]+)\}\}/g;

export interface WorkflowV2PromptResolution {
  slug: string;
  requestedVersion: PromptReferenceSelector;
  resolvedVersion: number;
}

export interface WorkflowV2MigrationDiagnostic {
  code: string;
  message: string;
  nodeId: string | null;
  path?: string;
}

export interface WorkflowV2MigrationResult {
  sourceDefinitionId: number;
  sourceVersion: number;
  targetSchemaVersion: 2;
  conversionHash: string | null;
  definition: WorkflowDefinitionV2 | null;
  conversions: WorkflowV2MigrationDiagnostic[];
  warnings: WorkflowV2MigrationDiagnostic[];
  blockers: WorkflowV2MigrationDiagnostic[];
}

export interface ConvertWorkflowDefinitionV1ToV2Input {
  sourceDefinitionId: number;
  sourceVersion: number;
  definition: WorkflowDefinitionV1;
  registryContext: WorkflowBlockRegistryContext;
  promptResolutions?: ReadonlyMap<string, WorkflowV2PromptResolution>;
  harnessProfiles?: Partial<
    Record<
      HarnessProvider,
      {
        reference: HarnessProfileReference;
        modelId: string;
      }
    >
  >;
}

type DiagnosticKind = "conversion" | "warning" | "blocker";

const AGENT_BLOCK_TYPES: ReadonlySet<WorkflowBlockType> = new Set([
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
]);

interface ConversionState {
  input: ConvertWorkflowDefinitionV1ToV2Input;
  graph: WorkflowBindingGraphContext;
  conversions: WorkflowV2MigrationDiagnostic[];
  warnings: WorkflowV2MigrationDiagnostic[];
  blockers: WorkflowV2MigrationDiagnostic[];
}

export function workflowV2PromptResolutionKey(
  reference: Pick<ParsedPromptReference, "slug" | "legacyPromptId" | "version">,
): string {
  const target =
    reference.slug === undefined ? `id:${reference.legacyPromptId}` : `slug:${reference.slug}`;
  return `${target}@${reference.version}`;
}

export function deterministicV2ControlEdgeId(input: {
  sourceDefinitionId: number;
  sourceVersion: number;
  edgeIndex: number;
  from: string;
  to: string;
  fromPort?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        sourceDefinitionId: input.sourceDefinitionId,
        sourceVersion: input.sourceVersion,
        edgeIndex: input.edgeIndex,
        from: input.from,
        to: input.to,
        fromPort: input.fromPort ?? null,
      }),
    )
    .digest("hex");
  return `edge-${digest.slice(0, 24)}`;
}

export function convertWorkflowDefinitionV1ToV2(
  input: ConvertWorkflowDefinitionV1ToV2Input,
): WorkflowV2MigrationResult {
  const state: ConversionState = {
    input,
    graph: buildWorkflowBindingGraphContext(input.definition),
    conversions: [],
    warnings: [],
    blockers: [],
  };

  inspectDefinitionEnvelope(state);
  inspectBindingSafety(state);

  const nodes = input.definition.nodes.map((node, nodeIndex) =>
    convertNode(state, node, nodeIndex),
  );
  const edges = input.definition.edges.map((edge, edgeIndex) => {
    const path = `/edges/${edgeIndex}`;
    const source = state.graph.nodeById.get(edge.from);
    if (!source) {
      addDiagnostic(
        state,
        "blocker",
        "migration.edge.unknown_source",
        `Connection ${edgeIndex + 1} references unknown source block "${edge.from}".`,
        null,
        `${path}/from`,
      );
    }
    if (!state.graph.nodeById.has(edge.to)) {
      addDiagnostic(
        state,
        "blocker",
        "migration.edge.unknown_target",
        `Connection ${edgeIndex + 1} references unknown target block "${edge.to}".`,
        null,
        `${path}/to`,
      );
    }
    if (edge.fromPort === FAILURE_PORT) {
      addDiagnostic(
        state,
        "blocker",
        "migration.edge.failure_port",
        `Connection from "${edge.from}" to "${edge.to}" uses the v1 execution-failure port and cannot be represented in v2.`,
        edge.from,
        `${path}/fromPort`,
      );
    } else if (
      source &&
      edge.fromPort !== undefined &&
      !BLOCK_TYPE_SPECS[source.type].ports.includes(edge.fromPort)
    ) {
      addDiagnostic(
        state,
        "blocker",
        "migration.edge.unknown_port",
        `Connection from "${edge.from}" uses unknown output "${edge.fromPort}".`,
        edge.from,
        `${path}/fromPort`,
      );
    }

    const id = deterministicV2ControlEdgeId({
      sourceDefinitionId: input.sourceDefinitionId,
      sourceVersion: input.sourceVersion,
      edgeIndex,
      from: edge.from,
      to: edge.to,
      ...(edge.fromPort === undefined ? {} : { fromPort: edge.fromPort }),
    });
    addDiagnostic(
      state,
      "conversion",
      "migration.edge.id_assigned",
      `Assigned stable control-edge id "${id}".`,
      edge.from,
      `${path}/id`,
    );
    return {
      id,
      from: edge.from,
      to: edge.to,
      ...(edge.fromPort === undefined ? {} : { fromPort: edge.fromPort }),
    };
  });

  const candidate: WorkflowDefinitionV2 = {
    schemaVersion: 2,
    ...(input.definition.budgets === undefined
      ? {}
      : { budgets: structuredClone(input.definition.budgets) }),
    nodes,
    edges,
  };
  for (const issue of validateWorkflowDefinitionIssuesForDeployment(
    candidate,
    input.registryContext,
  )) {
    addDiagnostic(
      state,
      "blocker",
      `migration.target.${issue.code}`,
      `Converted v2 workflow is not deployable: ${issue.message}`,
      issue.nodeId,
      issue.path,
    );
  }
  const blockers = dedupeDiagnostics(state.blockers);
  const definition = blockers.length === 0 ? candidate : null;
  return {
    sourceDefinitionId: input.sourceDefinitionId,
    sourceVersion: input.sourceVersion,
    targetSchemaVersion: 2,
    conversionHash:
      definition === null
        ? null
        : createHash("sha256")
            .update(
              stableStringify({
                converterVersion: CONVERTER_VERSION,
                sourceDefinitionId: input.sourceDefinitionId,
                sourceVersion: input.sourceVersion,
                definition,
              }),
            )
            .digest("hex"),
    definition,
    conversions: dedupeDiagnostics(state.conversions),
    warnings: dedupeDiagnostics(state.warnings),
    blockers,
  };
}

function inspectDefinitionEnvelope(state: ConversionState): void {
  const definition = state.input.definition as WorkflowDefinitionV1 & Record<string, unknown>;
  for (const key of Object.keys(definition)) {
    if (!["schemaVersion", "budgets", "nodes", "edges"].includes(key)) {
      addDiagnostic(
        state,
        "blocker",
        "migration.definition.unknown_configuration",
        `Workflow contains unsupported top-level field "${key}".`,
        null,
        `/${escapePointerSegment(key)}`,
      );
    }
  }

  const seenNodeIds = new Set<string>();
  for (const [nodeIndex, node] of state.input.definition.nodes.entries()) {
    if (node.id === "entry") {
      addDiagnostic(
        state,
        "blocker",
        "migration.node.reserved_id",
        'Block id "entry" is reserved for the virtual active trigger in v2.',
        node.id,
        `/nodes/${nodeIndex}/id`,
      );
    }
    if (seenNodeIds.has(node.id)) {
      addDiagnostic(
        state,
        "blocker",
        "migration.node.duplicate_id",
        `Block id "${node.id}" is duplicated.`,
        node.id,
        `/nodes/${nodeIndex}/id`,
      );
    }
    seenNodeIds.add(node.id);
  }
}

function inspectBindingSafety(state: ConversionState): void {
  for (const issue of validateWorkflowBindingIssues(
    state.input.definition,
    state.input.registryContext,
    state.graph,
  )) {
    addDiagnostic(
      state,
      "blocker",
      "migration.binding.unprovable",
      issue.message,
      issue.nodeId,
      issue.path,
    );
  }
}

function convertNode(
  state: ConversionState,
  node: WorkflowDefinitionV1["nodes"][number],
  nodeIndex: number,
): WorkflowDefinitionV2Node {
  const nodePath = `/nodes/${nodeIndex}`;
  const rawNode = node as WorkflowDefinitionV1["nodes"][number] & Record<string, unknown>;
  for (const key of Object.keys(rawNode)) {
    if (!["id", "type", "name", "x", "y", "params", "promptRefs", "inputs"].includes(key)) {
      addDiagnostic(
        state,
        "blocker",
        "migration.node.unknown_configuration",
        `Block "${node.id}" contains unsupported field "${key}".`,
        node.id,
        `${nodePath}/${escapePointerSegment(key)}`,
      );
    }
  }

  const allowedParams = new Set(BLOCK_PARAM_KEYS[node.type]);
  const configuration: Record<string, JsonValue> = {};
  for (const [paramName, value] of Object.entries(node.params)) {
    const path = `${nodePath}/params/${escapePointerSegment(paramName)}`;
    if (!allowedParams.has(paramName)) {
      addDiagnostic(
        state,
        "blocker",
        "migration.node.unknown_parameter",
        `Block "${node.id}" contains unsupported parameter "${paramName}"; it was not removed.`,
        node.id,
        path,
      );
    }
    configuration[paramName] = convertConfigurationValue(
      state,
      node,
      paramName,
      value,
      path,
    );
  }

  if (AGENT_BLOCK_TYPES.has(node.type)) {
    pinMigratedAgentHarnessProfile(state, node, configuration, nodePath);
  }

  if (node.type === "branch") {
    convertBranchCondition(state, node, configuration, nodeIndex);
  }

  if (node.promptRefs && Object.keys(node.promptRefs).length > 0) {
    addDiagnostic(
      state,
      "warning",
      "migration.prompt.provenance_removed",
      `Block "${node.id}" has v1 copied-prompt provenance metadata. Its prompt text is preserved, but the informational copy marker is not part of v2.`,
      node.id,
      `${nodePath}/promptRefs`,
    );
  }

  const contract = resolveWorkflowBlockContract(
    node.type,
    node.params,
    state.input.registryContext,
  );
  const inputs: Record<string, WorkflowInputBindingV2> = {};
  const additionalInputs: WorkflowAdditionalInputV2[] = [];
  for (const [inputName, source] of Object.entries(node.inputs)) {
    const inputPath = `${nodePath}/inputs/${escapePointerSegment(inputName)}`;
    const binding = convertBinding(state, node.id, source, inputPath);
    const fixed = Object.prototype.hasOwnProperty.call(contract.inputs, inputName);
    if (fixed) {
      if (binding) inputs[inputName] = binding;
      continue;
    }

    const additional = contract.additionalInputs.find(({ keyPattern }) =>
      new RegExp(keyPattern).test(inputName),
    );
    if (!additional) {
      addDiagnostic(
        state,
        "blocker",
        "migration.input.unknown",
        `Block "${node.id}" input "${inputName}" has no v2 input contract.`,
        node.id,
        inputPath,
      );
      continue;
    }
    const schema = workflowValueSchemaToJsonSchema(additional.schema);
    if (!schema) {
      addDiagnostic(
        state,
        "blocker",
        "migration.input.schema_unrepresentable",
        `Block "${node.id}" input "${inputName}" has a contract that cannot be represented as JSON Schema.`,
        node.id,
        inputPath,
      );
      continue;
    }
    if (binding) {
      additionalInputs.push({ name: inputName, schema, binding });
      addDiagnostic(
        state,
        "conversion",
        "migration.input.additional_materialized",
        `Materialized additional input "${inputName}" with its registry-owned schema.`,
        node.id,
        inputPath,
      );
    }
  }

  addDiagnostic(
    state,
    "conversion",
    "migration.node.configuration",
    `Moved block "${node.id}" parameters into v2 configuration.`,
    node.id,
    `${nodePath}/configuration`,
  );
  return {
    id: node.id,
    type: node.type,
    ...(node.name === undefined ? {} : { name: node.name }),
    x: node.x,
    y: node.y,
    configuration,
    inputs,
    additionalInputs,
  };
}

function pinMigratedAgentHarnessProfile(
  state: ConversionState,
  node: WorkflowDefinitionV1["nodes"][number],
  configuration: Record<string, JsonValue>,
  nodePath: string,
): void {
  const provider: HarnessProvider =
    configuration.provider === "claude" || configuration.provider === "codex"
      ? configuration.provider
      : state.input.registryContext.defaultAgent.provider;
  const builtin = BUILTIN_HARNESS_PROFILE_MANIFESTS[
    provider === "claude" ? "builtin-claude" : "builtin-codex"
  ];
  const target = state.input.harnessProfiles?.[provider] ?? {
    reference: builtinHarnessProfileReference(provider),
    modelId: builtin.model.id,
  };
  const explicitModel =
    typeof configuration.model === "string" &&
    configuration.model.trim().length > 0
      ? configuration.model.trim()
      : null;
  if (explicitModel !== null && explicitModel !== target.modelId) {
    addDiagnostic(
      state,
      "blocker",
      "migration.agent.profile_model_override",
      `Block "${node.id}" selects model "${explicitModel}", which is not represented by the published ${provider} Harness Profile model "${target.modelId}". Create and select a matching Harness Profile before converting this workflow.`,
      node.id,
      `${nodePath}/params/model`,
    );
  }
  delete configuration.provider;
  delete configuration.model;
  configuration.harnessProfile = {
    profileId: target.reference.profileId,
    version: target.reference.version,
  };
  addDiagnostic(
    state,
    "conversion",
    "migration.agent.profile_pinned",
    `Pinned block "${node.id}" to Harness Profile "${target.reference.profileId}" version ${target.reference.version}.`,
    node.id,
    `${nodePath}/configuration/harnessProfile`,
  );
}

function convertConfigurationValue(
  state: ConversionState,
  node: WorkflowDefinitionV1["nodes"][number],
  paramName: string,
  value: WorkflowDefinitionV1["nodes"][number]["params"][string],
  path: string,
): JsonValue {
  if (!(VARIABLE_PARAM_KEYS[node.type] ?? []).includes(paramName)) {
    return structuredClone(value);
  }
  if (typeof value === "string") {
    return rewritePromptText(state, node, value, path);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      rewritePromptText(state, node, item, `${path}/${index}`),
    );
  }
  return value;
}

function rewritePromptText(
  state: ConversionState,
  node: WorkflowDefinitionV1["nodes"][number],
  source: string,
  path: string,
): string {
  let text = source;
  if (containsMalformedPromptReference(text)) {
    addDiagnostic(
      state,
      "blocker",
      "migration.prompt.malformed_reference",
      `Block "${node.id}" contains a malformed reusable-prompt reference.`,
      node.id,
      path,
    );
  }

  const promptTokens = parsePromptReferenceTokens(text);
  for (const token of [...promptTokens].reverse()) {
    const resolution = state.input.promptResolutions?.get(
      workflowV2PromptResolutionKey(token),
    );
    if (!resolution) {
      addDiagnostic(
        state,
        "blocker",
        "migration.prompt.unresolved_reference",
        `Block "${node.id}" reusable-prompt reference "${token.raw}" could not be pinned to an exact version.`,
        node.id,
        path,
      );
      continue;
    }
    const pinned = formatPromptReferenceToken({
      slug: resolution.slug,
      version: resolution.resolvedVersion,
    });
    text = `${text.slice(0, token.start)}${pinned}${text.slice(token.end)}`;
    if (pinned !== token.raw) {
      addDiagnostic(
        state,
        "conversion",
        "migration.prompt.reference_pinned",
        `Pinned "${token.raw}" to "${pinned}".`,
        node.id,
        path,
      );
    }
  }

  text = text.replace(PROMPT_VARIABLE_PATTERN, (raw, variable: string) => {
    const reference = promptVariableReference(state, node, variable);
    if (!reference) {
      addDiagnostic(
        state,
        "blocker",
        "migration.prompt.unsafe_variable",
        `Block "${node.id}" legacy prompt variable "${raw}" has no provably available v2 data source.`,
        node.id,
        path,
      );
      return raw;
    }
    const replacement = `{{data:${reference}}}`;
    addDiagnostic(
      state,
      "conversion",
      "migration.prompt.variable_converted",
      `Converted legacy prompt variable "${raw}" to "${replacement}".`,
      node.id,
      path,
    );
    return replacement;
  });

  text = text.replace(ANY_PLACEHOLDER_PATTERN, (token, rawBody: string) => {
    const body = rawBody.trim();
    if (body.startsWith("prompt:")) {
      if (parsePromptReferenceTokens(token).length === 1) return token;
    } else if (body.startsWith("data:")) {
      const reference = body.slice("data:".length);
      if (!isWorkflowDataReferenceV2(reference)) {
        addDiagnostic(
          state,
          "blocker",
          "migration.prompt.invalid_data_reference",
          `Block "${node.id}" contains non-canonical data reference "${token}".`,
          node.id,
          path,
        );
        return token;
      }
      if (!isReferenceGuaranteed(state, node.id, reference)) {
        addDiagnostic(
          state,
          "blocker",
          "migration.prompt.unavailable_data_reference",
          `Block "${node.id}" data reference "${token}" is not guaranteed at this block.`,
          node.id,
          path,
        );
        return token;
      }
      const canonicalToken = `{{data:${reference}}}`;
      if (canonicalToken !== token) {
        addDiagnostic(
          state,
          "conversion",
          "migration.prompt.data_reference_canonicalized",
          `Canonicalized data reference "${token}" to "${canonicalToken}".`,
          node.id,
          path,
        );
      }
      return canonicalToken;
    }
    addDiagnostic(
      state,
      "blocker",
      "migration.prompt.unresolved_placeholder",
      `Block "${node.id}" contains unsupported placeholder "${token}".`,
      node.id,
      path,
    );
    return token;
  });
  return text;
}

function promptVariableReference(
  state: ConversionState,
  node: WorkflowDefinitionV1["nodes"][number],
  variable: string,
): WorkflowDataReferenceV2 | null {
  const entryPaths: Record<string, string[]> = {
    ticket_key: ["ticketKey"],
    ticket_title: ["ticket", "title"],
    ticket_description: ["ticket", "description"],
    ticket_acceptance_criteria: ["ticket", "acceptanceCriteria"],
    ticket_labels: ["ticket", "labels"],
    pr_number: ["prNumber"],
    pr_url: ["prUrl"],
    pr_title: ["title"],
    repo_path: ["repoPath"],
    pr_review_feedback: ["review", "body"],
  };
  if (variable === "run_id") return "run.id";
  if (variable === "branch_name") return "run.branchName";

  if (variable === "plan_markdown") {
    const explicit = node.inputs.plan;
    if (explicit) {
      const reference = canonicalReference(explicit);
      return reference && isReferenceGuaranteed(state, node.id, reference)
        ? reference
        : null;
    }
    if (entryPathGuaranteed(state, node.id, ["approvedPlan"])) {
      return "steps.entry.output.approvedPlan";
    }
    return uniqueDominatingOutputReference(state, node.id, "planning_agent", ["plan"]);
  }
  if (variable === "change_summary") {
    return uniqueDominatingOutputReference(
      state,
      node.id,
      "implementation_agent",
      ["summary"],
    );
  }

  const path = entryPaths[variable];
  if (!path || !entryPathGuaranteed(state, node.id, path)) return null;
  return `steps.entry.output.${path.join(".")}`;
}

function entryPathGuaranteed(
  state: ConversionState,
  consumerId: string,
  path: readonly string[],
): boolean {
  const reachingTriggers = state.input.definition.nodes.filter(
    (candidate) =>
      isTriggerBlockType(candidate.type) &&
      (state.graph.reachableFromTrigger.get(candidate.id)?.has(consumerId) ?? false),
  );
  return (
    reachingTriggers.length > 0 &&
    reachingTriggers.every((trigger) => {
      const contract = resolveWorkflowBlockContract(
        trigger.type,
        trigger.params,
        state.input.registryContext,
      );
      return (
        resolveRequiredWorkflowSchemaPath(contract.output.bindingSchema, path) !== null
      );
    })
  );
}

function uniqueDominatingOutputReference(
  state: ConversionState,
  consumerId: string,
  sourceType: WorkflowDefinitionV1["nodes"][number]["type"],
  path: readonly string[],
): WorkflowDataReferenceV2 | null {
  const sources = state.input.definition.nodes.filter((candidate) => {
    if (
      candidate.type !== sourceType ||
      !(state.graph.dominators.get(consumerId)?.has(candidate.id) ?? false)
    ) {
      return false;
    }
    const contract = resolveWorkflowBlockContract(
      candidate.type,
      candidate.params,
      state.input.registryContext,
    );
    return (
      resolveRequiredWorkflowSchemaPath(contract.output.bindingSchema, path) !== null
    );
  });
  if (sources.length !== 1) return null;
  return `steps.${sources[0].id}.output.${path.join(".")}`;
}

function convertBranchCondition(
  state: ConversionState,
  node: WorkflowDefinitionV1["nodes"][number],
  configuration: Record<string, JsonValue>,
  nodeIndex: number,
): void {
  const condition = node.params.condition;
  if (typeof condition !== "string") return;
  const parsed = parseCondition(condition);
  if (!parsed.ok) {
    addDiagnostic(
      state,
      "blocker",
      "migration.branch.unparseable_condition",
      `Branch "${node.id}" condition cannot be parsed: ${parsed.error}.`,
      node.id,
      `/nodes/${nodeIndex}/params/condition`,
    );
    return;
  }

  let provable = true;
  visitConditionPaths(parsed.ast, (sourceId, segments) => {
    const source = state.graph.nodeById.get(sourceId);
    const dominates = state.graph.dominators.get(node.id)?.has(sourceId) ?? false;
    const output =
      source &&
      resolveWorkflowBlockContract(
        source.type,
        source.params,
        state.input.registryContext,
      ).output.bindingSchema;
    if (
      !source ||
      !dominates ||
      !output ||
      resolveRequiredWorkflowSchemaPath(output, segments) === null
    ) {
      provable = false;
      addDiagnostic(
        state,
        "blocker",
        "migration.branch.unprovable_reference",
        `Branch "${node.id}" condition reference "steps.${sourceId}.output${segments.length > 0 ? `.${segments.join(".")}` : ""}" is not guaranteed at the branch.`,
        node.id,
        `/nodes/${nodeIndex}/params/condition`,
      );
    }
  });
  if (!provable) return;
  configuration.condition = conditionAstToJson(parsed.ast);
  addDiagnostic(
    state,
    "conversion",
    "migration.branch.condition_parsed",
    `Parsed Branch "${node.id}" condition into a typed Boolean tree.`,
    node.id,
    `/nodes/${nodeIndex}/configuration/condition`,
  );
}

function visitConditionPaths(
  ast: ConditionAst,
  visit: (blockId: string, segments: string[]) => void,
): void {
  switch (ast.kind) {
    case "path":
      visit(ast.blockId, ast.segments);
      return;
    case "not":
      visitConditionPaths(ast.operand, visit);
      return;
    case "and":
    case "or":
    case "eq":
    case "neq":
      visitConditionPaths(ast.left, visit);
      visitConditionPaths(ast.right, visit);
      return;
    case "lit":
      return;
  }
}

function conditionAstToJson(ast: ConditionAst): JsonValue {
  switch (ast.kind) {
    case "lit":
      return { kind: "lit", value: ast.value };
    case "path":
      return {
        kind: "path",
        reference: `steps.${ast.blockId}.output${
          ast.segments.length > 0 ? `.${ast.segments.join(".")}` : ""
        }`,
      };
    case "not":
      return { kind: "not", operand: conditionAstToJson(ast.operand) };
    case "and":
    case "or":
    case "eq":
    case "neq":
      return {
        kind: ast.kind,
        left: conditionAstToJson(ast.left),
        right: conditionAstToJson(ast.right),
      };
  }
}

function convertBinding(
  state: ConversionState,
  nodeId: string,
  source: string,
  path: string,
): WorkflowInputBindingV2 | null {
  const reference = canonicalReference(source);
  if (!reference || !isReferenceGuaranteed(state, nodeId, reference)) {
    addDiagnostic(
      state,
      "blocker",
      "migration.binding.unprovable",
      `Block "${nodeId}" binding "${source}" cannot be converted to a guaranteed v2 data reference.`,
      nodeId,
      path,
    );
    return null;
  }
  if (reference !== source) {
    addDiagnostic(
      state,
      "conversion",
      "migration.binding.canonicalized",
      `Converted "${source}" to "${reference}".`,
      nodeId,
      path,
    );
  }
  return { kind: "reference", reference };
}

function canonicalReference(source: string): WorkflowDataReferenceV2 | null {
  const parsed = parseWorkflowBindingSource(source);
  if (!parsed) return null;
  if (parsed.root === "trigger") {
    return `steps.entry.output.${parsed.path.join(".")}`;
  }
  if (parsed.root === "steps") {
    return `steps.${parsed.nodeId}.output.${parsed.path.join(".")}`;
  }
  return `run.${parsed.path.join(".")}`;
}

function isReferenceGuaranteed(
  state: ConversionState,
  consumerId: string,
  reference: string,
): boolean {
  if (!isWorkflowDataReferenceV2(reference)) return false;
  const segments = reference.split(".");
  if (segments[0] === "run") {
    return (
      resolveRequiredWorkflowSchemaPath(RUN_BINDING_SCHEMA, segments.slice(1)) !==
      null
    );
  }
  const sourceId = segments[1];
  const path = segments.slice(3);
  if (sourceId === "entry") return entryPathGuaranteed(state, consumerId, path);
  const source = state.graph.nodeById.get(sourceId);
  if (
    !source ||
    isTriggerBlockType(source.type) ||
    !(state.graph.dominators.get(consumerId)?.has(sourceId) ?? false)
  ) {
    return false;
  }
  const contract = resolveWorkflowBlockContract(
    source.type,
    source.params,
    state.input.registryContext,
  );
  return (
    resolveRequiredWorkflowSchemaPath(contract.output.bindingSchema, path) !== null
  );
}

function workflowValueSchemaToJsonSchema(
  schema: WorkflowValueSchema,
): JsonSchema202012 | null {
  const metadata = {
    ...(schema.description === undefined ? {} : { description: schema.description }),
    ...(schema.enum === undefined ? {} : { enum: structuredClone(schema.enum) }),
  };
  switch (schema.type) {
    case "unknown":
      return null;
    case "string":
    case "number":
    case "boolean":
    case "null":
      return { type: schema.type, ...metadata };
    case "array": {
      const items = workflowValueSchemaToJsonSchema(schema.items);
      return items ? { type: "array", items, ...metadata } : null;
    }
    case "object": {
      const entries = Object.entries(schema.properties).map(([name, child]) => [
        name,
        workflowValueSchemaToJsonSchema(child),
      ] as const);
      if (entries.some(([, child]) => child === null)) return null;
      return {
        type: "object",
        properties: Object.fromEntries(entries) as Record<string, JsonSchema202012>,
        required: [...schema.required],
        additionalProperties: schema.additionalProperties,
        ...metadata,
      };
    }
    case "nullable": {
      const inner = workflowValueSchemaToJsonSchema(schema.value);
      if (!inner || typeof inner.type !== "string") return null;
      return {
        ...inner,
        type: [inner.type, "null"],
        ...metadata,
      };
    }
  }
}

function addDiagnostic(
  state: ConversionState,
  kind: DiagnosticKind,
  code: string,
  message: string,
  nodeId: string | null,
  path?: string,
): void {
  const diagnostic = {
    code,
    message,
    nodeId,
    ...(path === undefined ? {} : { path }),
  };
  if (kind === "conversion") state.conversions.push(diagnostic);
  else if (kind === "warning") state.warnings.push(diagnostic);
  else state.blockers.push(diagnostic);
}

function dedupeDiagnostics(
  diagnostics: WorkflowV2MigrationDiagnostic[],
): WorkflowV2MigrationDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = stableStringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
