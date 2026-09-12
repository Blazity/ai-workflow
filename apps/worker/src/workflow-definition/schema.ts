import { z } from "zod";
import type {
  JsonSchema202012,
  JsonValue,
  TransformConfiguration,
  WorkflowBlockType,
  WorkflowBlockTypeV1,
  WorkflowDataCatalogEntry,
  WorkflowDataReferenceV2,
  WorkflowDefinition,
  WorkflowDefinitionNode,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
  WorkflowDefinitionValidationIssue,
  WorkflowBlockContractResolver,
  WorkflowParamValue,
  VcsProviderKind,
} from "@shared/contracts";
import {
  BLOCK_PARAM_KEYS,
  BLOCK_TYPE_SPECS,
  FAILURE_PORT,
  isHarnessProfileReference,
  isSafeWorkflowInputName,
  isTriggerBlockType,
  isV2AgentBlockType,
  isWorkflowAddressablePathSegment,
  evaluateWorkflowValueCompatibility,
} from "@shared/contracts";
import { resolveBuiltinHarnessProfile } from "@shared/harness";
import {
  MINIMUM_PERIOD_MS,
  parseSchedule,
  violatesMinimumPeriod,
} from "../engine/definition/schedule-occurrence.js";
import {
  workflowBlockDeploymentDefinitionIssues,
  workflowRepositoryScopeIssues,
} from "./block-registry.js";
import {
  analyzeWorkflowV2Bindings,
  analyzeWorkflowV2Catalog,
} from "./available-values.js";
import { validateTransformDefinition } from "./transform.js";
import { validateWorkflowV2WorkspaceAccessIssues } from "./workspace-access.js";

/**
 * The per-type block parameter parsers these rules validate a definition
 * against. Declared where the parameter is taken, not where the map is
 * composed (`engine/definition/block-params-schemas.ts`), so these rules keep
 * no import back to the block modules the map pulls in.
 */
export type WorkflowBlockParamsSchemas = Record<WorkflowBlockType, z.ZodTypeAny>;
const nodeId = z.string().trim().min(1);
const coordinate = z.number().finite();
const bindingInputName = z.custom<string>(
  (name) => typeof name === "string" && isSafeWorkflowInputName(name),
  { message: "Input name contains an empty or unsafe path segment." },
);

const vcsProviders = z.enum(["github", "gitlab"]);
export const vcsProviderSelection = z.array(vcsProviders).min(1);

// Sized far above any hand-drawn workflow (the built-in default is 8 blocks/7
// connections) but low enough to bound validateWorkflowGraph, whose dominator
// fixpoint is O(N^2*E) and copies the node universe per node.
//
// Exported so the MCP tool catalog's own size gate can be pinned against them
// (mcp/tool-catalog.test.ts): the catalog restates the numbers rather than
// importing them, because it is loaded on the transport path and must stay out
// of this module's graph, and a restated number that drifts below these would
// leave an agent able to read a graph it can never save back.
export const MAX_NODES = 200;
export const MAX_EDGES = 400;
const executionBudgetsSchema = z
  .object({
    maxDurationMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().finite().positive().optional(),
  })
  .strict();

const MAX_PINNED_REPOSITORIES = 8;

// At least one slash, more allowed for nested GitLab group paths. Stricter than
// REPO_PATH_RE in lib/repo-allowlist.ts: this also rejects inner whitespace, which
// neither provider permits in a path. Duplicated rather than imported on purpose,
// because repo-allowlist.ts pulls in the pino logger and this file is reachable
// from the workflow isolate, where a CJS/node:* import compiles to require() and
// throws at runtime while local tests stay green.
const definitionRepoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s/]+(?:\/[^\s/]+)+$/);

// Repositories pinned to the definition. Case is preserved as the operator picked
// it, so uniqueness compares on the lowercased path the way repositoryKey does in
// pre-sandbox/steps/repo-selection.ts.
const repositoryScopeSchema = z
  .object({
    repositories: z
      .array(
        z
          .object({ provider: vcsProviders, repoPath: definitionRepoPathSchema })
          .strict(),
      )
      .max(
        MAX_PINNED_REPOSITORIES,
        `A workflow cannot pin more than ${MAX_PINNED_REPOSITORIES} repositories.`,
      )
      .refine(
        (repositories) =>
          new Set(
            repositories.map((repo) => `${repo.provider}:${repo.repoPath.toLowerCase()}`),
          ).size === repositories.length,
        "Pinned repositories must be unique.",
      )
      .optional(),
    providers: vcsProviderSelection.optional(),
  })
  .strict();

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const UNSAFE_REFERENCE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isSafeReferencePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !/\s/.test(segment) &&
    !UNSAFE_REFERENCE_SEGMENTS.has(segment)
  );
}

export function isWorkflowDataReferenceV2(
  value: unknown,
): value is WorkflowDataReferenceV2 {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const segments = value.split(".");
  if (segments[0] === "run") {
    return segments.length >= 2 && segments.slice(1).every(isSafeReferencePathSegment);
  }
  if (
    segments[0] !== "steps" ||
    segments.length < 3 ||
    segments[2] !== "output"
  ) {
    return false;
  }
  const sourceId = segments[1];
  return (
    (sourceId === "entry" || isWorkflowAddressablePathSegment(sourceId)) &&
    segments.slice(3).every(isSafeReferencePathSegment)
  );
}

export const workflowInputBindingV2Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("reference"),
        reference: z.custom<WorkflowDataReferenceV2>(
          (value) => isWorkflowDataReferenceV2(value),
          {
            message:
              "Reference must use steps.entry.output.*, steps.<nodeId>.output.*, or run.*.",
          },
        ),
      })
      .strict(),
    z
      .object({
        kind: z.literal("reference_list"),
        references: z
          .array(
            z.custom<WorkflowDataReferenceV2>(
              (value) => isWorkflowDataReferenceV2(value),
              {
                message:
                  "Reference must use steps.entry.output.*, steps.<nodeId>.output.*, or run.*.",
              },
            ),
          )
          .min(1),
      })
      .strict(),
    z.object({ kind: z.literal("literal"), value: jsonValueSchema }).strict(),
  ],
);

// Transform shape parsing deliberately preserves semantically incomplete
// drafts. Unsafe/empty names and paths are deployment issues reported by the
// Transform validator, so Save can retain an in-progress visual configuration.
const transformDraftNameSchema = z.string().max(200);
const workflowDataReferenceSchema = z.custom<WorkflowDataReferenceV2>(
  (value) => typeof value === "string" && isWorkflowDataReferenceV2(value),
  { message: "Value must use a canonical v2 data reference." },
);
const transformBuildObjectValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reference"),
      reference: workflowDataReferenceSchema,
      defaultValue: z
        .union([z.string(), z.number(), z.boolean(), z.null()])
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("literal"),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
]);
const transformBuildObjectFieldSchema = z
  .object({
    name: transformDraftNameSchema,
    value: transformBuildObjectValueSchema,
  })
  .strict();
export const transformConfigurationSchema: z.ZodType<TransformConfiguration> = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("format_text"), template: z.string() }).strict(),
    z.object({ operation: z.literal("trim_text"), source: workflowDataReferenceSchema }).strict(),
    z
      .object({
        operation: z.literal("replace_text"),
        source: workflowDataReferenceSchema,
        mode: z.enum(["plain", "regex"]),
        pattern: z.string(),
        replacement: z.string(),
        ignoreCase: z.boolean(),
      })
      .strict(),
    z.object({ operation: z.literal("text_to_number"), source: workflowDataReferenceSchema }).strict(),
    z.object({ operation: z.literal("number_to_text"), source: workflowDataReferenceSchema }).strict(),
    z
      .object({
        operation: z.literal("parse_json"),
        source: workflowDataReferenceSchema,
        expectedSchema: z
          .object({
            dialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
            source: z.string(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        operation: z.literal("build_object"),
        fields: z.array(transformBuildObjectFieldSchema).max(100),
      })
      .strict(),
  ],
);

/** Loop carries are named, typed values the next attempt reads, so the shape is
 *  read both by the params schema map and by the loop port rules below. */
export const v2LoopConfiguration = z
  .object({
    maxAttempts: z.number().int().min(1).max(20),
    onExhaust: z.enum(["fail", "human", "continue"]),
    carry: z
      .array(
        z
          .object({
            name: bindingInputName,
            schema: z.record(z.string(), jsonValueSchema),
            binding: workflowInputBindingV2Schema,
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();

const v2BranchConditionSchema = z
  .object({
    reference: workflowDataReferenceSchema,
    operator: z.enum([
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "greater_than",
      "greater_than_or_equal",
      "less_than",
      "less_than_or_equal",
      "has_value",
      "has_no_value",
    ]),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    ignoreCase: z.boolean().optional(),
  })
  .strict();
export const v2BranchConfigurationSchema = z
  .object({
    combinator: z.enum(["all", "any"]),
    conditions: z.array(v2BranchConditionSchema).max(100),
  })
  .strict();

const workflowDefinitionV2NodeSchema = z
  .object({
    id: nodeId,
    type: z.custom<WorkflowBlockType>(
      (type) =>
        typeof type === "string" &&
        Object.prototype.hasOwnProperty.call(BLOCK_TYPE_SPECS, type),
      { message: "Unknown workflow block type." },
    ),
    name: z.string().optional(),
    x: coordinate,
    y: coordinate,
    configuration: z.record(z.string(), jsonValueSchema),
    inputs: z.record(bindingInputName, workflowInputBindingV2Schema),
    additionalInputs: z
      .array(
        z
          .object({
            name: bindingInputName,
            schema: z.record(z.string(), jsonValueSchema),
            binding: workflowInputBindingV2Schema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

const workflowDefinitionV2ControlEdgeSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    fromPort: z.string().trim().min(1).optional(),
  })
  .strict();

const workflowDefinitionV2ParsedSchema = z
  .object({
    schemaVersion: z.literal(2),
    budgets: executionBudgetsSchema.optional(),
    repositoryScope: repositoryScopeSchema.optional(),
    nodes: z
      .array(workflowDefinitionV2NodeSchema)
      .max(MAX_NODES, `Workflow cannot have more than ${MAX_NODES} blocks.`),
    edges: z
      .array(workflowDefinitionV2ControlEdgeSchema)
      .max(MAX_EDGES, `Workflow cannot have more than ${MAX_EDGES} connections.`),
  })
  .strict()
  .superRefine((definition, context) => {
    for (const [nodeIndex, node] of definition.nodes.entries()) {
      if (node.type !== "transform") continue;
      const parsed = transformConfigurationSchema.safeParse(node.configuration);
      if (parsed.success) continue;
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", nodeIndex, "configuration", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

export const workflowDefinitionV2Schema = z.preprocess(
  normalizeV2AgentProfileConfiguration,
  workflowDefinitionV2ParsedSchema,
);

function normalizeV2AgentProfileConfiguration(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const definition = value as Record<string, unknown>;
  if (!Array.isArray(definition.nodes)) return value;
  let changed = false;
  const nodes = definition.nodes.map((rawNode) => {
    if (
      rawNode === null ||
      typeof rawNode !== "object" ||
      Array.isArray(rawNode)
    ) {
      return rawNode;
    }
    const node = rawNode as Record<string, unknown>;
    if (
      typeof node.type !== "string" ||
      !isV2AgentBlockType(node.type as WorkflowBlockType) ||
      node.configuration === null ||
      typeof node.configuration !== "object" ||
      Array.isArray(node.configuration)
    ) {
      return node;
    }
    const configuration = node.configuration as Record<string, unknown>;
    if (!isHarnessProfileReference(configuration.harnessProfile)) {
      return node;
    }
    const normalized = { ...configuration };
    delete normalized.provider;
    delete normalized.model;
    changed = true;
    return { ...node, configuration: normalized };
  });
  return changed ? { ...definition, nodes } : value;
}

/** Parses a stored row into the runnable graph, applying the deterministic
 * normalizations the live schema owns. Throws on anything it cannot read, so
 * stored-definition.ts settles the retired schema before calling this. */
export function upgradeStoredWorkflowDefinition(raw: unknown): WorkflowDefinition {
  return workflowDefinitionV2Schema.parse(raw);
}

export function describeWorkflowDefinitionIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
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

function validateWorkflowV2ConfigurationIssues(
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

function v2ConfigurationParams(
  node: WorkflowDefinitionV2Node,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
): Record<string, WorkflowParamValue> {
  // Branch and Transform keep their configuration out of params: their typed
  // shapes are operations, never executor params.
  const parsedConfiguration =
    node.type === "branch" || node.type === "transform"
      ? null
      : blockParamsSchemas[node.type].safeParse(node.configuration);
  const configuration =
    parsedConfiguration?.success === true
      ? (parsedConfiguration.data as Record<string, unknown>)
      : node.configuration;
  const params: Record<string, WorkflowParamValue> = {};
  for (const [name, value] of Object.entries(configuration)) {
    if (
      name === "harnessProfile" ||
      name === "outputSchemaDialect" ||
      name === "promptSlotBindings"
    ) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) &&
        value.every((item) => typeof item === "string"))
    ) {
      params[name] = value;
    }
  }
  if (isHarnessProfileReference(node.configuration.harnessProfile)) {
    const profile = resolveBuiltinHarnessProfile(
      node.configuration.harnessProfile,
    );
    if (profile !== null) {
      params.provider = profile.harness.provider;
      params.model = profile.model.id;
    }
  }
  return params;
}

function validateWorkflowV2BlockDeploymentIssues(
  def: WorkflowDefinitionV2,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  options: { checkEnvironmentAvailability?: boolean },
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    const params = v2ConfigurationParams(node, blockParamsSchemas);
    if (
      node.type === "trigger_schedule" &&
      (typeof params.cron !== "string" || params.cron.trim() === "")
    ) {
      issues.push(
        deploymentIssue(
          `Block "${node.id}" (trigger_schedule) must configure a cron schedule before deployment.`,
          node.id,
          `/nodes/${nodeIndex}/configuration/cron`,
        ),
      );
    }
    if (
      node.type === "trigger_schedule" &&
      (typeof params.taskTitle !== "string" || params.taskTitle.trim() === "")
    ) {
      issues.push(
        deploymentIssue(
          `Block "${node.id}" (trigger_schedule) must configure a task title before deployment.`,
          node.id,
          `/nodes/${nodeIndex}/configuration/taskTitle`,
        ),
      );
    }
    if (
      node.type === "trigger_schedule" &&
      (typeof params.taskDescription !== "string" || params.taskDescription.trim() === "")
    ) {
      issues.push(
        deploymentIssue(
          `Block "${node.id}" (trigger_schedule) must configure a task description before deployment.`,
          node.id,
          `/nodes/${nodeIndex}/configuration/taskDescription`,
        ),
      );
    }
    // Schedule semantics come from the schedule-trigger evaluator and are never
    // re-implemented here. The deployment gate, the editor's preview and the
    // once-a-minute dispatcher have to agree about when a schedule fires, and
    // one shared module is the only way to guarantee that. It also keeps the
    // cron library out of this file, which is imported almost everywhere.
    //
    // Only runs on a non-empty cron: an empty one already has its own issue
    // above, and reporting "empty" and "invalid syntax" for one field in one
    // deploy is noise rather than help.
    if (
      node.type === "trigger_schedule" &&
      typeof params.cron === "string" &&
      params.cron.trim() !== "" &&
      // A non-string timezone already has a type issue from the configuration
      // schema, so it is left alone rather than given a second complaint.
      (node.configuration.timezone === undefined ||
        typeof node.configuration.timezone === "string")
    ) {
      // Only a genuinely absent key gets the schema default. A key that is
      // present goes to the evaluator exactly as authored, empty string
      // included.
      //
      // The distinction is the whole check. `z.string().default("UTC")` fills in
      // a *missing* key, so `timezone: ""` parses fine, and substituting "UTC"
      // for it here would let a blank zone deploy clean and then have every
      // single tick come back invalid at runtime, which is precisely the silent
      // fallback this stage exists to prevent, in the last place able to catch it
      // before shipping.
      const timezone = node.configuration.timezone ?? "UTC";
      const parsed = parseSchedule(params.cron, timezone);

      if (!parsed.ok && parsed.problem.reason === "invalid-timezone") {
        issues.push(
          deploymentIssue(
            `Block "${node.id}" (trigger_schedule) must configure a known IANA timezone before deployment: ${parsed.problem.message}`,
            node.id,
            `/nodes/${nodeIndex}/configuration/timezone`,
          ),
        );
      } else if (!parsed.ok) {
        issues.push(
          deploymentIssue(
            `Block "${node.id}" (trigger_schedule) must configure a valid cron expression before deployment: ${parsed.problem.message}`,
            node.id,
            `/nodes/${nodeIndex}/configuration/cron`,
          ),
        );
      } else {
        // `new Date()` rather than a threaded clock: this validator has no clock
        // parameter and its entry point is used across the codebase, so wiring
        // one through for this check alone would be a far larger change than it
        // earns.
        //
        // The verdict genuinely can depend on the instant, because the check
        // samples MINIMUM_PERIOD_SAMPLE occurrences forward from now. Measured:
        // in Australia/Lord_Howe, whose daylight-saving shift is thirty minutes,
        // `0,20,40 * * * *` is accepted on most days and refused near the
        // transition, where its real minimum gap is ten minutes. Accepted as a
        // known limit, since no bounded sample can prove a cron expression's
        // minimum over all time, and the preset builder avoids the whole class by
        // compiling intervals in UTC.
        const problem = violatesMinimumPeriod(
          params.cron,
          timezone,
          new Date(),
        );
        if (problem?.reason === "below-minimum-period") {
          issues.push(
            deploymentIssue(
              `Block "${node.id}" (trigger_schedule) must leave at least ${MINIMUM_PERIOD_MS / 60_000} minutes between runs before deployment: ${problem.message} Agent runs occupy a small shared pool, so a schedule firing faster than that can starve the rest of the queue.`,
              node.id,
              `/nodes/${nodeIndex}/configuration/cron`,
            ),
          );
        } else if (problem) {
          // Only "never-occurs" reaches here, the expression and the timezone
          // both parsed. Same field to fix, different wording on purpose:
          // telling someone their never-firing schedule is too frequent would
          // send them looking in the wrong place.
          issues.push(
            deploymentIssue(
              `Block "${node.id}" (trigger_schedule) must configure a cron expression with upcoming occurrences before deployment: ${problem.message}`,
              node.id,
              `/nodes/${nodeIndex}/configuration/cron`,
            ),
          );
        }
      }
    }

    const definitionIssues = workflowBlockDeploymentDefinitionIssues(
      node.type,
      params,
    );
    if (definitionIssues.length > 0) {
      issues.push(
        ...definitionIssues.map((issue) => ({
          code: issue.code,
          severity: "error" as const,
          nodeId: node.id,
          path: `/nodes/${nodeIndex}/configuration/outputSchema${issue.path}`,
          message: `Block "${node.id}" (${node.type}) is unavailable: ${issue.message}`,
        })),
      );
    } else if (options.checkEnvironmentAvailability !== false) {
      const availability = resolveContract(node.type, params).availability;
      if (!availability.available) {
        issues.push(
          deploymentIssue(
            `Block "${node.id}" (${node.type}) is unavailable: ${availability.unavailableReason}`,
            node.id,
            `/nodes/${nodeIndex}/configuration`,
          ),
        );
      }
    }
  }
  issues.push(...unattendedScheduleGraphIssues(def), ...pinnedScheduleRepositoryIssues(def));
  return issues;
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
      deploymentIssue(
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
    deploymentIssue(
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

function validateWorkflowV2BranchConditionIssues(
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

function validateWorkflowV2TransformReferenceIssues(
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

function validateWorkflowGraphV2Issues(
  def: WorkflowDefinitionV2,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const addIssue = (message: string, issueNodeId: string | null = null, path?: string) => {
    issues.push(deploymentIssue(message, issueNodeId, path));
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
          ...validateTransformDefinition({
            configuration: configuration.data,
          }).map((issue) => ({
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

  return dedupeDeploymentIssues(issues);
}

/** Validation required before a definition may become executable. Draft saves
 * use `workflowDefinitionSchema` plus `validateWorkflowGraph` only so an
 * operator can keep editing a structurally sound but incomplete graph. */
export function validateWorkflowDefinitionForDeployment(
  def: WorkflowDefinition,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
  options: {
    checkEnvironmentAvailability?: boolean;
  } = {},
): string[] {
  return validateWorkflowDefinitionIssuesForDeployment(
    def,
    resolveContract,
    blockParamsSchemas,
    configuredVcsProviders,
    options,
  ).map(({ message }) => message);
}

export function validateWorkflowDefinitionIssuesForDeployment(
  def: WorkflowDefinition,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
  options: {
    checkEnvironmentAvailability?: boolean;
  } = {},
): WorkflowDefinitionValidationIssue[] {
  const bindingAnalysis = analyzeWorkflowV2Bindings(def, resolveContract);
  const catalogAnalysis = analyzeWorkflowV2Catalog(def, resolveContract);
  const issues = dedupeDeploymentIssues([
    ...validateWorkflowGraphV2Issues(def),
    ...validateWorkflowV2ConfigurationIssues(def, blockParamsSchemas),
    ...validateWorkflowV2BlockDeploymentIssues(
      def,
      resolveContract,
      blockParamsSchemas,
      options,
    ),
    ...bindingAnalysis.issues,
    ...validateWorkflowV2BranchConditionIssues(
      def,
      catalogAnalysis.catalogByNode,
    ),
    ...validateWorkflowV2TransformReferenceIssues(
      def,
      catalogAnalysis.catalogByNode,
    ),
    ...validateWorkflowV2WorkspaceAccessIssues(def),
    ...repositoryScopePinIssues(def, configuredVcsProviders, options),
  ]);
  return issues;
}

/**
 * The definition-level repository pin belongs to no block, so the node walks
 * above never see it. Its issues carry `nodeId: null`, the way every other
 * definition-wide issue does, and flow through the same dedupe as the rest.
 */
function repositoryScopePinIssues(
  def: WorkflowDefinition,
  configuredVcsProviders: readonly VcsProviderKind[],
  options: { checkEnvironmentAvailability?: boolean },
): WorkflowDefinitionValidationIssue[] {
  return workflowRepositoryScopeIssues(
    def.repositoryScope,
    configuredVcsProviders,
    options,
  ).map((message) => deploymentIssue(message, null, "/repositoryScope"));
}

function deploymentIssue(
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

function dedupeDeploymentIssues(
  issues: WorkflowDefinitionValidationIssue[],
): WorkflowDefinitionValidationIssue[] {
  return issues.filter(
    (issue, index) =>
      issues.findIndex(
        (candidate) =>
          candidate.code === issue.code &&
          candidate.nodeId === issue.nodeId &&
          candidate.path === issue.path &&
          candidate.message === issue.message,
      ) === index,
  );
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
          deploymentIssue(
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
