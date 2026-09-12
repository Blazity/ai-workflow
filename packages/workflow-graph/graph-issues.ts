/**
 * The structural rules: everything a workflow definition can be wrong about
 * that needs no environment, no stored state and no clock.
 *
 * Ids, ports, reachability, cycles, loop and branch shape, per-type parameter
 * parsing, branch and transform reference compatibility, and the two schedule
 * rules that are pure graph reachability. What is NOT here is deployment
 * validation: harness profile existence, prompt references, schedule occurrence
 * evaluation, block availability, repository scope. Those read the environment
 * or stored state and live in the worker, which composes both halves in
 * `apps/worker/src/workflow-definition/deployment-validation.ts`.
 *
 * The split is invisible to an author only if the ORDER survives it, so the
 * functions here are shaped around the sequence the worker splices them in
 * rather than around tidy rule families: `workflowDefinitionStructuralIssues`
 * is the head of the list, `workflowScheduleGraphIssues` the tail of the
 * worker's per-node deployment walk, `workflowValueReferenceIssues` the pair
 * that follows the available-values pass.
 */
import type {
  JsonSchema202012,
  JsonValue,
  TransformConfiguration,
  WorkflowBlockType,
  WorkflowBlockTypeV1,
  WorkflowDataCatalogEntry,
  WorkflowDataReferenceV2,
  WorkflowDefinitionNode,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import {
  BLOCK_PARAM_KEYS,
  BLOCK_TYPE_SPECS,
  FAILURE_PORT,
  evaluateWorkflowValueCompatibility,
  isHarnessProfileReference,
  isTriggerBlockType,
  isV2AgentBlockType,
  isWorkflowAddressablePathSegment,
} from "@shared/contracts";
import {
  transformConfigurationSchema,
  v2BranchConfigurationSchema,
  v2LoopConfiguration,
  type WorkflowBlockParamsSchemas,
} from "./schema";

/**
 * One complaint from the Transform shape validator.
 *
 * Declared structurally rather than imported because the implementation
 * (`./transform.ts`) checks a transform's expected schema through the ajv the
 * worker binds, so the graph walk takes the validator already bound to it and
 * never learns what backs it. `apps/worker/src/workflow-definition/deployment-validation.ts`
 * is where the two meet.
 */
export interface WorkflowTransformShapeIssue {
  code: string;
  path: string;
  message: string;
}

export type WorkflowTransformShapeValidator = (
  configuration: TransformConfiguration,
) => readonly WorkflowTransformShapeIssue[];

/**
 * The shape every graph-wide complaint carries. `code: "deployment"` is the
 * wire value these issues have always carried and is what the editor keys on;
 * it names the field, not a policy, and a structural rule emits it too.
 */
export function workflowDefinitionIssue(
  message: string,
  issueNodeId: string | null,
  path?: string,
): WorkflowDefinitionValidationIssue {
  return {
    code: "deployment",
    severity: "error",
    nodeId: issueNodeId,
    ...(path ? { path } : {}),
    message,
  };
}

/**
 * The one issue de-duplication in the repository. Every composed list runs
 * through it exactly once, keeping the first occurrence, because a complaint an
 * author already read further up the list is noise the second time.
 */
export function dedupeWorkflowDefinitionIssues(
  issues: readonly WorkflowDefinitionValidationIssue[],
): WorkflowDefinitionValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([
      issue.code,
      issue.nodeId,
      issue.path ?? null,
      issue.message,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface GraphEdge {
  from: string;
  to: string;
  port: string;
  fromType: WorkflowBlockType;
}

function findCycle(adjacency: Map<string, string[]>, nodeIds: string[]): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);

  for (const start of nodeIds) {
    if (color.get(start) !== WHITE) continue;
    const stack: { node: string; idx: number }[] = [{ node: start, idx: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.idx < neighbors.length) {
        const next = neighbors[frame.idx];
        frame.idx += 1;
        const shade = color.get(next);
        if (shade === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, idx: 0 });
        } else if (shade === GRAY) {
          const startIdx = stack.findIndex((entry) => entry.node === next);
          const path = stack.slice(startIdx).map((entry) => entry.node);
          path.push(next);
          return path;
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

function stronglyConnectedComponents(
  adjacency: Map<string, string[]>,
  nodeIds: string[],
): string[][] {
  let counter = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const componentStack: string[] = [];
  const result: string[][] = [];

  for (const start of nodeIds) {
    if (indices.has(start)) continue;
    const work: { node: string; idx: number }[] = [{ node: start, idx: 0 }];
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const node = frame.node;
      if (frame.idx === 0) {
        indices.set(node, counter);
        lowlink.set(node, counter);
        counter += 1;
        componentStack.push(node);
        onStack.add(node);
      }
      const neighbors = adjacency.get(node) ?? [];
      if (frame.idx < neighbors.length) {
        const next = neighbors[frame.idx];
        frame.idx += 1;
        if (!indices.has(next)) {
          work.push({ node: next, idx: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(next)!));
        }
      } else {
        if (lowlink.get(node) === indices.get(node)) {
          const component: string[] = [];
          for (;;) {
            const popped = componentStack.pop()!;
            onStack.delete(popped);
            component.push(popped);
            if (popped === node) break;
          }
          result.push(component);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work.at(-1)!.node;
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!));
        }
      }
    }
  }
  return result;
}

function reachableFrom(seeds: string[], adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function jsonPointerSegment(value: string | number): string {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function invalidConfigurationIssue(
  node: WorkflowDefinitionV2Node,
  nodeIndex: number,
  relativePath: readonly (string | number)[],
  message: string,
): WorkflowDefinitionValidationIssue {
  const suffix = relativePath.map(jsonPointerSegment).join("/");
  return {
    code: "invalid_configuration",
    severity: "error",
    nodeId: node.id,
    path: `/nodes/${nodeIndex}/configuration${suffix.length > 0 ? `/${suffix}` : ""}`,
    message: `Block "${node.id}" (${node.type}) has invalid configuration: ${message}`,
  };
}

/**
 * The head of a definition's issue list: graph shape, then per-type
 * configuration. Both walks stay in one function because the worker splices its
 * own deployment walk in immediately after them, and their relative order is
 * what an author sees.
 */
export function workflowDefinitionStructuralIssues(
  def: WorkflowDefinitionV2,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  validateTransformShape: WorkflowTransformShapeValidator,
): WorkflowDefinitionValidationIssue[] {
  return [
    ...workflowGraphV2Issues(def, validateTransformShape),
    ...workflowConfigurationV2Issues(def, blockParamsSchemas),
  ];
}

function workflowConfigurationV2Issues(
  def: WorkflowDefinitionV2,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    // Transform has a purpose-built shape and semantic validator. Keeping it
    // separate avoids accidentally accepting executor params as operations.
    if (node.type === "transform") continue;

    const allowedKeys = new Set([
      ...BLOCK_PARAM_KEYS[node.type],
      ...(node.type === "branch" ? ["combinator", "conditions"] : []),
      ...(node.type === "loop" ? ["carry"] : []),
      ...(isV2AgentBlockType(node.type)
        ? ["harnessProfile", "promptSlotBindings"]
        : []),
      ...(node.type === "generic_agent" || node.type === "call_llm"
        ? ["outputSchemaDialect"]
        : []),
    ]);
    for (const key of Object.keys(node.configuration)) {
      if (allowedKeys.has(key)) continue;
      issues.push(
        invalidConfigurationIssue(
          node,
          nodeIndex,
          [key],
          `property "${key}" is not supported.`,
        ),
      );
    }

    const parsed = blockParamsSchemas[node.type].safeParse(node.configuration);
    const profileReference = node.configuration.harnessProfile;
    if (
      parsed.success &&
      isV2AgentBlockType(node.type) &&
      isHarnessProfileReference(profileReference) &&
      (node.configuration.provider !== undefined || node.configuration.model !== undefined)
    ) {
      issues.push(
        invalidConfigurationIssue(
          node,
          nodeIndex,
          ["harnessProfile"],
          "provider and model cannot override a pinned Harness Profile.",
        ),
      );
    }
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      // Emit one exact issue per unknown property above instead of Zod's
      // aggregate object-level "unrecognized keys" diagnostic.
      if (issue.code === "unrecognized_keys") continue;
      issues.push(
        invalidConfigurationIssue(
          node,
          nodeIndex,
          issue.path.map((segment) =>
            typeof segment === "number" ? segment : String(segment),
          ),
          issue.message,
        ),
      );
    }
  }
  return issues;
}

/**
 * The two schedule rules that need nothing but the graph.
 *
 * They are exported separately because the worker reports them at the tail of
 * its per-node deployment walk, where they have always been: moving them to the
 * head of the structural list would reorder what an author reads.
 */
export function workflowScheduleGraphIssues(
  def: WorkflowDefinitionV2,
): WorkflowDefinitionValidationIssue[] {
  return [...unattendedScheduleGraphIssues(def), ...pinnedScheduleRepositoryIssues(def)];
}

/**
 * Blocks that park a run until a person answers. Both of them suspend the
 * workflow and leave the subject claimed while it waits.
 */
const HUMAN_WAIT_BLOCK_TYPES = new Set<WorkflowBlockType>([
  "human_question",
  "send_plan_approval",
]);

/**
 * A graph entered through trigger_schedule may not contain a block that waits for
 * a human.
 *
 * A parked subject is deliberately protected from reconciliation
 * (lib/reconcile.ts), so under the skip and queue policies one run stopped on a
 * question holds the schedule's subject forever and FREEZES the schedule: every
 * later occurrence is skipped or queued behind a run nobody will ever answer. And
 * there is no way out, because no product surface can cancel a scheduled run:
 * cancellation from Slack addresses runs by ticket key, and a scheduled run has no
 * ticket.
 *
 * So this is a deliberate limitation with a real cost (no recurring workflow can
 * ask for plan approval) accepted in exchange for a schedule that cannot wedge
 * itself. Reported per offending block, because the author needs to know which
 * one to remove.
 */
function unattendedScheduleGraphIssues(
  def: WorkflowDefinitionV2,
): WorkflowDefinitionValidationIssue[] {
  const scheduleNodes = def.nodes.filter((node) => node.type === "trigger_schedule");
  if (scheduleNodes.length === 0) return [];

  // Every edge counts, loop back-edges included: reachability is only used to ask
  // whether a schedule CAN arrive at a human wait, and a wider answer there errs
  // towards refusing the deploy rather than shipping a schedule that can freeze.
  const forward = new Map<string, string[]>();
  for (const node of def.nodes) forward.set(node.id, []);
  for (const edge of def.edges) forward.get(edge.from)?.push(edge.to);

  const reachable = reachableFrom(
    scheduleNodes.map((node) => node.id),
    forward,
  );
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    if (!HUMAN_WAIT_BLOCK_TYPES.has(node.type) || !reachable.has(node.id)) continue;
    issues.push(
      workflowDefinitionIssue(
        `Block "${node.id}" (${node.type}) waits for a person, and it is reachable from the schedule trigger. A recurring trigger runs unattended: a run parked on a decision holds the schedule's turn indefinitely, and nothing can release it. Remove it from the scheduled path.`,
        node.id,
        `/nodes/${nodeIndex}`,
      ),
    );
  }
  return issues;
}

/**
 * A graph entered through trigger_schedule that reaches prepare_workspace must
 * have a repository pinned on the definition.
 *
 * Every other trigger arrives with something that names the repository: a ticket
 * carries its own routing memory, and a pull request trigger carries the pull
 * request. A scheduled occurrence carries neither. Its pseudo-ticket has no
 * labels for the routing memory to read (workflows/workflow-ticket.ts) and a
 * fresh identifier per occurrence, so there is no branch from the previous
 * occurrence to fall back on either. That leaves the discovery agent guessing
 * from the task description alone, and anything short of a confident answer
 * becomes needs_human_input, which a scheduled run is not allowed to park on
 * (assertScheduledRunMayNotPark in agent.ts) and so fails the run.
 *
 * What makes it worth refusing the deploy rather than letting it fail at runtime:
 * the input is byte-identical on every occurrence, so the guess fails the same way
 * forever, and the run has no ticket, so applyDefaultFailure returns before it can
 * comment or notify. A nightly schedule would fail silently every night with a run
 * row as its only trace.
 *
 * Reported at the pin rather than at a block, the way every other definition-wide
 * issue is, because the fix is the definition's repository pin and not any one
 * block's configuration.
 */
function pinnedScheduleRepositoryIssues(
  def: WorkflowDefinitionV2,
): WorkflowDefinitionValidationIssue[] {
  if ((def.repositoryScope?.repositories ?? []).length > 0) return [];
  const scheduleNodes = def.nodes.filter((node) => node.type === "trigger_schedule");
  if (scheduleNodes.length === 0) return [];

  // Same reachability walk and the same widening as the unattended rule above:
  // every edge counts, because a wider answer here only refuses a deploy that
  // could have shipped a schedule guessing at its own repository.
  const forward = new Map<string, string[]>();
  for (const node of def.nodes) forward.set(node.id, []);
  for (const edge of def.edges) forward.get(edge.from)?.push(edge.to);

  const reachable = reachableFrom(
    scheduleNodes.map((node) => node.id),
    forward,
  );
  const workspace = def.nodes.find(
    (node) => node.type === "prepare_workspace" && reachable.has(node.id),
  );
  if (!workspace) return [];
  return [
    workflowDefinitionIssue(
      `Block "${workspace.id}" (prepare_workspace) is reachable from schedule trigger "${scheduleNodes[0].id}", and this workflow pins no repository. A scheduled run carries no ticket, no routing labels, and a fresh branch every occurrence, so nothing in it names a repository and the choice falls to the discovery agent. Every occurrence hands that agent identical input, so an uncertain answer fails the run the same way every time, and with no ticket there is nowhere to report the failure. Pin the repositories this schedule works in.`,
      null,
      "/repositoryScope",
    ),
  ];
}

type BranchComparableType =
  | "boolean"
  | "null"
  | "number"
  | "string";

function comparableTypeForLiteral(
  value: string | number | boolean | null,
): BranchComparableType {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function comparableTypesForSchema(
  schema: JsonSchema202012,
): Set<BranchComparableType> | null {
  const rawTypes =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type) &&
          schema.type.every((value) => typeof value === "string")
        ? schema.type
        : null;
  if (rawTypes === null) {
    const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
    return enumValues.length > 0 &&
      enumValues.every(
        (value): value is string | number | boolean | null =>
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean",
      )
      ? new Set(enumValues.map(comparableTypeForLiteral))
      : null;
  }

  const types = new Set<BranchComparableType>();
  for (const type of rawTypes) {
    if (type === "integer") {
      types.add("number");
    } else if (
      type === "boolean" ||
      type === "null" ||
      type === "number" ||
      type === "string"
    ) {
      types.add(type);
    } else {
      return null;
    }
  }
  return types.size > 0 ? types : null;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function schemaAllowsLiteral(
  schema: JsonSchema202012,
  value: string | number | boolean | null,
): boolean {
  const types = comparableTypesForSchema(schema);
  if (types !== null && !types.has(comparableTypeForLiteral(value))) return false;
  if (Array.isArray(schema.enum)) {
    return schema.enum.some((candidate) => jsonValuesEqual(candidate, value));
  }
  return true;
}

/**
 * What Branch and Transform may read, checked against the catalog of values the
 * available-values pass says each block can see when it runs.
 *
 * The catalog arrives as data: deriving it needs the worker's block contract
 * resolver, and these rules only ask what is in it.
 */
export function workflowValueReferenceIssues(
  def: WorkflowDefinitionV2,
  catalogByNode: Record<string, WorkflowDataCatalogEntry[]>,
): WorkflowDefinitionValidationIssue[] {
  return [
    ...branchConditionIssues(def, catalogByNode),
    ...transformReferenceIssues(def, catalogByNode),
  ];
}

function branchConditionIssues(
  def: WorkflowDefinitionV2,
  catalogByNode: Record<string, WorkflowDataCatalogEntry[]>,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    if (node.type !== "branch") continue;
    const parsed = v2BranchConfigurationSchema.safeParse(node.configuration);
    if (!parsed.success) continue;

    const catalog = new Map(
      (catalogByNode[node.id] ?? []).map((value) => [value.reference, value]),
    );
    const addIssue = (
      relativePath: readonly (string | number)[],
      message: string,
    ) => {
      issues.push(
        invalidConfigurationIssue(node, nodeIndex, relativePath, message),
      );
    };
    if (parsed.data.conditions.length === 0) {
      addIssue(["conditions"], "at least one condition is required.");
    }
    for (const [conditionIndex, condition] of parsed.data.conditions.entries()) {
      const path = ["conditions", conditionIndex] as const;
      const entry = catalog.get(condition.reference);
      if (!entry) {
        addIssue(
          [...path, "reference"],
          `reference "${condition.reference}" is not available when this Branch runs.`,
        );
        continue;
      }
      if (entry.availability.state === "unavailable") {
        addIssue([...path, "reference"], entry.availability.reason);
        continue;
      }
      const types = comparableTypesForSchema(entry.schema);
      const presence =
        condition.operator === "has_value" ||
        condition.operator === "has_no_value";
      if (presence) {
        if (condition.value !== undefined) {
          addIssue([...path, "value"], "presence conditions do not accept a comparison value.");
        }
        continue;
      }
      const compatibility = evaluateWorkflowValueCompatibility(entry, {
        kind: "branch",
      });
      if (!compatibility.compatible) {
        addIssue(
          [...path, "reference"],
          compatibility.reason.message,
        );
        continue;
      }
      if (condition.value === undefined) {
        addIssue([...path, "value"], "a comparison value is required.");
        continue;
      }
      if (types === null) {
        addIssue([...path, "reference"], "the selected value is not scalar-comparable.");
        continue;
      }
      const ordered = [
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
      ].includes(condition.operator);
      const contains = ["contains", "not_contains"].includes(condition.operator);
      if (ordered && !types.has("number")) {
        addIssue([...path, "operator"], "ordered comparisons require a number.");
      }
      if (contains && !types.has("string")) {
        addIssue([...path, "operator"], "contains comparisons require text.");
      }
      if (!schemaAllowsLiteral(entry.schema, condition.value)) {
        addIssue([...path, "value"], "the comparison value is incompatible with the selected value.");
      }
      if (
        condition.ignoreCase !== undefined &&
        !(
          types.has("string") &&
          ["equals", "not_equals", "contains", "not_contains"].includes(
            condition.operator,
          )
        )
      ) {
        addIssue(
          [...path, "ignoreCase"],
          "ignore capitalization is available only for text comparisons.",
        );
      }
    }
  }
  return issues;
}

function transformReferenceIssues(
  def: WorkflowDefinitionV2,
  catalogByNode: Record<string, WorkflowDataCatalogEntry[]>,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    if (node.type !== "transform") continue;
    const parsed = transformConfigurationSchema.safeParse(node.configuration);
    if (!parsed.success) continue;
    const catalog = new Map(
      (catalogByNode[node.id] ?? []).map((entry) => [entry.reference, entry]),
    );
    const add = (path: readonly (string | number)[], message: string) =>
      issues.push(invalidConfigurationIssue(node, nodeIndex, path, message));
    const resolve = (
      reference: WorkflowDataReferenceV2,
      path: readonly (string | number)[],
    ): WorkflowDataCatalogEntry | null => {
      const entry = catalog.get(reference);
      if (!entry) {
        add(
          path,
          `reference "${reference}" is not available when this Transform runs.`,
        );
        return null;
      }
      return entry;
    };
    const config = parsed.data;
    if (config.operation === "format_text") continue;
    if (config.operation === "build_object") {
      for (const [fieldIndex, field] of config.fields.entries()) {
        if (field.value.kind !== "reference") continue;
        const path = ["fields", fieldIndex, "value"] as const;
        const entry = resolve(field.value.reference, [...path, "reference"]);
        if (!entry) continue;
        const compatibility = evaluateWorkflowValueCompatibility(entry, {
          kind: "build_object",
        });
        if (!compatibility.compatible) {
          add(
            [...path, "reference"],
            compatibility.reason.message,
          );
          continue;
        }
        if (field.value.defaultValue === undefined) continue;
        const optional =
          entry.presence !== "required" ||
          comparableTypesForSchema(entry.schema)?.has("null") === true;
        if (!optional) {
          add([...path, "defaultValue"], "defaults are allowed only for nullable or maybe-missing values.");
        } else if (!schemaAllowsLiteral(entry.schema, field.value.defaultValue)) {
          add([...path, "defaultValue"], "default value is incompatible with the selected value.");
        }
      }
      continue;
    }
    const entry = resolve(config.source, ["source"]);
    if (!entry) continue;
    const compatibility = evaluateWorkflowValueCompatibility(entry, {
      kind:
        config.operation === "number_to_text"
          ? "transform_number"
          : "transform_text",
    });
    if (!compatibility.compatible) {
      add(
        ["source"],
        compatibility.reason.message,
      );
      continue;
    }
    const types = comparableTypesForSchema(entry.schema);
    const requiresText =
      config.operation === "trim_text" ||
      config.operation === "replace_text" ||
      config.operation === "text_to_number" ||
      config.operation === "parse_json";
    if (requiresText && types?.has("string") !== true) {
      add(["source"], "this operation requires a text value.");
    }
    if (config.operation === "number_to_text" && types?.has("number") !== true) {
      add(["source"], "this operation requires a number value.");
    }
  }
  return issues;
}

function workflowGraphV2Issues(
  def: WorkflowDefinitionV2,
  validateTransformShape: WorkflowTransformShapeValidator,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const addIssue = (message: string, issueNodeId: string | null = null, path?: string) => {
    issues.push(workflowDefinitionIssue(message, issueNodeId, path));
  };
  const nodeById = new Map<string, WorkflowDefinitionV2Node>();
  for (const [nodeIndex, node] of def.nodes.entries()) {
    if (node.id === "entry") {
      addIssue(
        'Block id "entry" is reserved for the active trigger input.',
        node.id,
        `/nodes/${nodeIndex}/id`,
      );
    }
    if (!isWorkflowAddressablePathSegment(node.id)) {
      addIssue(
        `Block id "${node.id}" is not addressable; use a letter or underscore followed by letters, numbers, underscores, or hyphens.`,
        node.id,
        `/nodes/${nodeIndex}/id`,
      );
    }
    if (nodeById.has(node.id)) {
      addIssue(
        `Block id "${node.id}" is used more than once.`,
        node.id,
        `/nodes/${nodeIndex}/id`,
      );
    }
    nodeById.set(node.id, node);

    const additionalNames = new Set<string>();
    for (const [inputIndex, input] of node.additionalInputs.entries()) {
      if (additionalNames.has(input.name)) {
        addIssue(
          `Block "${node.id}" defines additional input "${input.name}" more than once.`,
          node.id,
          `/nodes/${nodeIndex}/additionalInputs/${inputIndex}/name`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(node.inputs, input.name)) {
        addIssue(
          `Block "${node.id}" uses "${input.name}" as both a fixed and additional input.`,
          node.id,
          `/nodes/${nodeIndex}/additionalInputs/${inputIndex}/name`,
        );
      }
      additionalNames.add(input.name);
    }

    if (node.type === "transform" || node.type === "branch") {
      for (const inputName of Object.keys(node.inputs)) {
        issues.push({
          code: "unknown_input",
          severity: "error",
          nodeId: node.id,
          path: `/nodes/${nodeIndex}/inputs/${inputName}`,
          message: `${node.type === "transform" ? "Transform" : "Branch"} block "${node.id}" does not accept generic input mappings.`,
        });
      }
      for (const [inputIndex] of node.additionalInputs.entries()) {
        issues.push({
          code: "unknown_input",
          severity: "error",
          nodeId: node.id,
          path: `/nodes/${nodeIndex}/additionalInputs/${inputIndex}`,
          message: `${node.type === "transform" ? "Transform" : "Branch"} block "${node.id}" does not accept additional typed inputs.`,
        });
      }
    }
    if (node.type === "transform") {
      const configuration = transformConfigurationSchema.safeParse(node.configuration);
      if (configuration.success) {
        issues.push(
          ...validateTransformShape(configuration.data).map((issue) => ({
            code: issue.code,
            severity: "error" as const,
            nodeId: node.id,
            path: `/nodes/${nodeIndex}${issue.path}`,
            message: `Transform block "${node.id}": ${issue.message}`,
          })),
        );
      }
    }

    const bindings = [
      ...Object.entries(node.inputs).map(([name, binding]) => ({
        path: `/nodes/${nodeIndex}/inputs/${name}`,
        binding,
      })),
      ...node.additionalInputs.map(({ binding }, inputIndex) => ({
        path: `/nodes/${nodeIndex}/additionalInputs/${inputIndex}/binding`,
        binding,
      })),
    ];
    for (const { path, binding } of bindings) {
      if (binding.kind !== "reference" || !binding.reference.startsWith("steps.")) continue;
      const sourceId = binding.reference.split(".")[1];
      if (sourceId === "entry") continue;
      if (!nodeById.has(sourceId) && !def.nodes.some((candidate) => candidate.id === sourceId)) {
        addIssue(
          `Block "${node.id}" references unknown block "${sourceId}".`,
          node.id,
          `${path}/reference`,
        );
      } else if (sourceId === node.id) {
        addIssue(
          `Block "${node.id}" cannot bind an input to its own output.`,
          node.id,
          `${path}/reference`,
        );
      }
    }
  }

  const triggerNodes = def.nodes.filter((node) => isTriggerBlockType(node.type));
  if (triggerNodes.length === 0) {
    addIssue("Workflow must contain at least one trigger block.", null, "/nodes");
  }

  const forward = new Map(def.nodes.map((node) => [node.id, [] as string[]]));
  const forwardWithoutLoopBack = new Map(
    def.nodes.map((node) => [node.id, [] as string[]]),
  );
  const incoming = new Map<string, number>();
  const edgeIds = new Set<string>();
  const exactEdges = new Set<string>();
  const usedPorts = new Map<string, Set<string>>();
  const graphEdges: GraphEdge[] = [];
  for (const [edgeIndex, edge] of def.edges.entries()) {
    if (edgeIds.has(edge.id)) {
      addIssue(
        `Connection id "${edge.id}" is used more than once.`,
        null,
        `/edges/${edgeIndex}/id`,
      );
    }
    edgeIds.add(edge.id);

    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (!fromNode) {
      addIssue(
        `Connection references an unknown source block "${edge.from}".`,
        null,
        `/edges/${edgeIndex}/from`,
      );
    }
    if (!toNode) {
      addIssue(
        `Connection references an unknown target block "${edge.to}".`,
        null,
        `/edges/${edgeIndex}/to`,
      );
    }
    if (edge.from === edge.to) {
      addIssue(`Block "${edge.from}" cannot connect to itself.`, edge.from, `/edges/${edgeIndex}`);
    }
    if (!fromNode || !toNode || edge.from === edge.to) continue;

    const ports = BLOCK_TYPE_SPECS[fromNode.type].ports;
    const resolvedPort = edge.fromPort ?? ports[0];
    if (edge.fromPort === FAILURE_PORT) {
      addIssue(
        `Connection from "${edge.from}" cannot use an execution-failure port in a v2 workflow.`,
        edge.from,
        `/edges/${edgeIndex}/fromPort`,
      );
    } else if (resolvedPort === undefined) {
      addIssue(
        `Terminal block "${edge.from}" (${fromNode.type}) cannot have outgoing connections.`,
        edge.from,
        `/edges/${edgeIndex}`,
      );
    } else if (!ports.includes(resolvedPort)) {
      addIssue(
        `Connection from "${edge.from}" uses unknown port "${resolvedPort}" of block type ${fromNode.type}.`,
        edge.from,
        `/edges/${edgeIndex}/fromPort`,
      );
    } else if (edge.fromPort === undefined && ports.length > 1) {
      addIssue(
        `Connection from "${edge.from}" must specify a port (${ports.join("/")}).`,
        edge.from,
        `/edges/${edgeIndex}/fromPort`,
      );
    }

    const exactKey = `${edge.from}\0${resolvedPort ?? ""}\0${edge.to}`;
    if (exactEdges.has(exactKey)) {
      addIssue(
        `Duplicate connection from "${edge.from}" to "${edge.to}".`,
        edge.from,
        `/edges/${edgeIndex}`,
      );
    }
    exactEdges.add(exactKey);
    if (resolvedPort !== undefined) {
      const portsForNode = usedPorts.get(edge.from) ?? new Set<string>();
      portsForNode.add(resolvedPort);
      usedPorts.set(edge.from, portsForNode);
      graphEdges.push({
        from: edge.from,
        to: edge.to,
        port: resolvedPort,
        fromType: fromNode.type,
      });
    }
    forward.get(edge.from)?.push(edge.to);
    if (!(fromNode.type === "loop" && resolvedPort === "continue")) {
      forwardWithoutLoopBack.get(edge.from)?.push(edge.to);
    }
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  for (const trigger of triggerNodes) {
    if ((incoming.get(trigger.id) ?? 0) > 0) {
      addIssue(
        `The trigger block "${trigger.id}" must not have incoming connections.`,
        trigger.id,
      );
    }
  }

  const reachable = reachableFrom(
    triggerNodes.map((node) => node.id),
    forward,
  );
  for (const node of def.nodes) {
    if (!isTriggerBlockType(node.type) && !reachable.has(node.id)) {
      addIssue(`Block "${node.id}" is not reachable from a trigger.`, node.id);
    }
    if (node.type === "branch") {
      const ports = usedPorts.get(node.id) ?? new Set<string>();
      if (!ports.has("true")) {
        addIssue(`Branch "${node.id}" must have its "true" port connected.`, node.id);
      }
      if (!ports.has("false")) {
        addIssue(`Branch "${node.id}" must have its "false" port connected.`, node.id);
      }
    } else if (node.type === "loop") {
      const ports = usedPorts.get(node.id) ?? new Set<string>();
      if (!ports.has("continue")) {
        addIssue(`Loop "${node.id}" must have its "continue" port connected.`, node.id);
      }
      const configuration = v2LoopConfiguration.safeParse(node.configuration);
      if (
        configuration.success &&
        configuration.data.onExhaust === "continue" &&
        !ports.has("exhausted")
      ) {
        addIssue(
          `Loop "${node.id}" with onExhaust "continue" must have its "exhausted" port connected.`,
          node.id,
        );
      }
      const continueTargets = graphEdges
        .filter((edge) => edge.from === node.id && edge.port === "continue")
        .map((edge) => edge.to);
      if (continueTargets.length > 0) {
        const downstream = reachableFrom(continueTargets, forward);
        if (!downstream.has(node.id)) {
          addIssue(`Loop "${node.id}"'s continue port must lead back to it.`, node.id);
        }
      }
    }
  }

  const cycle = findCycle(forwardWithoutLoopBack, def.nodes.map((node) => node.id));
  if (cycle) {
    addIssue(
      `Blocks ${cycle.map((id) => `"${id}"`).join(" -> ")} form a cycle that does not pass through a Loop block.`,
    );
  }

  for (const component of stronglyConnectedComponents(
    forward,
    def.nodes.map((node) => node.id),
  )) {
    if (component.length <= 1) continue;
    const loopCount = component.filter(
      (id) => nodeById.get(id)?.type === "loop",
    ).length;
    if (loopCount > 0) {
      for (const finalizeId of component.filter(
        (id) => nodeById.get(id)?.type === "finalize_workspace",
      )) {
        addIssue(
          `Finalize Workspace block "${finalizeId}" cannot execute inside a Loop cycle.`,
          finalizeId,
        );
      }
    }
    if (loopCount >= 2) {
      const rendered = component.map((id) => `"${id}"`).join(", ");
      addIssue(
        `Blocks [${rendered}] form a cycle region with ${loopCount} Loop blocks; each cycle region must contain exactly one.`,
      );
    }
  }

  return dedupeWorkflowDefinitionIssues(issues);
}

const ANY_SCOPE_BLOCK_POLICY = {
  trigger_ticket_ai: "deny",
  trigger_plan_approved: "deny",
  trigger_pr_created: "entry",
  trigger_pr_checks_failed: "entry",
  trigger_pr_review: "entry",
  trigger_pr_merged: "entry",
  planning_agent: "deny",
  implementation_agent: "deny",
  review_agent: "safe",
  fix_agent: "deny",
  generic_agent: "deny",
  prepare_workspace: "safe",
  finalize_workspace: "deny",
  run_pre_pr_checks: "deny",
  run_checks: "deny",
  call_llm: "safe",
  fetch_pr_context: "safe",
  // Read-only retrieval plus two LLM calls, exactly like call_llm and
  // fetch_pr_context: it reads Jira and Slack and mutates nothing.
  investigate: "safe",
  open_pr: "deny",
  update_ticket_status: "deny",
  post_ticket_comment: "deny",
  post_pr_comment: "safe",
  send_slack_message: "deny",
  send_plan_approval: "deny",
  human_question: "deny",
  // Guardrail classification is explicit: it inspects content and returns a
  // verdict, but owns no ticket/workspace/branch mutation.
  arthur_injection_check: "safe",
  // Nothing to guard on an any-scope path: Finalize, Open PR/MR, and the check
  // blocks it protects are all denied there, so the block would only add
  // repository-owned command surface inside the credential-bearing sandbox.
  leak_review: "deny",
  branch: "safe",
  loop: "safe",
  terminate: "deny",
} as const satisfies Record<WorkflowBlockTypeV1, "entry" | "safe" | "deny">;

/** The flattened runtime shape a run walks, which is what the check reads. */
export interface ReviewSafetyGraph {
  nodes: WorkflowDefinitionNode[];
  edges: Array<{ from: string; to: string; fromPort?: string }>;
}

export function validateAnyScopeReviewSafety(def: ReviewSafetyGraph): string[] {
  return validateAnyScopeReviewSafetyIssues(def).map(({ message }) => message);
}

function validateAnyScopeReviewSafetyIssues(
  def: ReviewSafetyGraph,
): WorkflowDefinitionValidationIssue[] {
  const nodes = new Map(def.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of def.edges) {
    const targets = outgoing.get(edge.from);
    if (targets) targets.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const trigger of def.nodes) {
    if (
      (trigger.type !== "trigger_pr_created" &&
        trigger.type !== "trigger_pr_checks_failed" &&
        trigger.type !== "trigger_pr_review" &&
        trigger.type !== "trigger_pr_merged") ||
      trigger.params.scope !== "any"
    ) {
      continue;
    }
    const seen = new Set<string>([trigger.id]);
    const queue = [...(outgoing.get(trigger.id) ?? [])];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      if (seen.has(id)) continue;
      seen.add(id);
      const node = nodes.get(id);
      if (!node) continue;
      if (ANY_SCOPE_BLOCK_POLICY[node.type] !== "safe") {
        issues.push(
          workflowDefinitionIssue(
            `scope:any trigger "${trigger.id}" reaches unsafe block "${node.id}" (${node.type}).`,
            node.id,
            `/nodes/${def.nodes.indexOf(node)}`,
          ),
        );
      }
      queue.push(...(outgoing.get(id) ?? []));
    }
  }
  return issues;
}
