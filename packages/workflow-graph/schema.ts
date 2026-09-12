/**
 * What a workflow definition is: the v2 parser, the shapes its blocks may
 * carry, and the deterministic upgrade a stored row goes through on the way in.
 *
 * Nothing here reads the environment or stored state. The per-type block
 * parameter parsers arrive as a parameter (`WorkflowBlockParamsSchemas`)
 * because composing them pulls in every block module, which is worker work.
 */
import { z } from "zod";
import type {
  JsonValue,
  TransformConfiguration,
  WorkflowBlockType,
  WorkflowDataReferenceV2,
} from "@shared/contracts";
import {
  BLOCK_TYPE_SPECS,
  isHarnessProfileReference,
  isSafeWorkflowInputName,
  isV2AgentBlockType,
  isWorkflowAddressablePathSegment,
} from "@shared/contracts";
import { MAX_EDGES, MAX_NODES } from "./limits";

/**
 * The per-type block parameter parsers the graph rules validate a definition
 * against. Declared where the parameter is taken, not where the map is
 * composed (`apps/worker/src/engine/definition/block-params-schemas.ts`), so
 * these rules keep no import back to the block modules the map pulls in.
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

const executionBudgetsSchema = z
  .object({
    maxDurationMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().finite().positive().optional(),
  })
  .strict();

const MAX_PINNED_REPOSITORIES = 8;

// At least one slash, more allowed for nested GitLab group paths. Stricter than
// REPO_PATH_RE in the worker's lib/repo-allowlist.ts: this also rejects inner
// whitespace, which neither provider permits in a path. Duplicated rather than
// imported on purpose, because repo-allowlist.ts pulls in the pino logger and
// this file is reachable from the workflow isolate, where a CJS/node:* import
// compiles to require() and throws at runtime while local tests stay green.
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
 *  read both by the params schema map and by the loop port rules in
 *  graph-issues.ts. */
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

export function describeWorkflowDefinitionIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}
