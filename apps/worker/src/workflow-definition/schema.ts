import { z } from "zod";
import type {
  JsonSchema202012,
  JsonValue,
  TransformConfiguration,
  TransformPredicate,
  WorkflowAvailableValuesByNode,
  WorkflowBindingSource,
  WorkflowBlockType,
  WorkflowBlockTypeV1,
  WorkflowBranchBooleanAstV2,
  WorkflowBranchOperandV2,
  WorkflowBranchPathOperandV2,
  WorkflowDataReferenceV2,
  WorkflowDefinition,
  WorkflowDefinitionV1,
  WorkflowDefinitionV1Edge,
  WorkflowDefinitionV1Node,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
  WorkflowDefinitionValidationIssue,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  BLOCK_PARAM_KEYS,
  BLOCK_TYPE_SPECS,
  FAILURE_PORT,
  isTriggerBlockType,
  isWorkflowAddressablePathSegment,
  wirablePorts,
} from "@shared/contracts";
import { parseCondition } from "@shared/conditions";
import { paramsSchema as prepareWorkspaceParams } from "../workflows/blocks/prepare-workspace.js";
import { paramsSchema as finalizeWorkspaceParams } from "../workflows/blocks/finalize-workspace.js";
import { paramsSchema as fixAgentParams } from "../workflows/blocks/fix-agent.js";
import { paramsSchema as genericAgentParams } from "../workflows/blocks/generic-agent.js";
import { paramsSchema as callLlmParams } from "../workflows/blocks/call-llm.js";
import { paramsSchema as fetchPrContextParams } from "../workflows/blocks/fetch-pr-context.js";
import { paramsSchema as runChecksParams } from "../workflows/blocks/run-checks.js";
import { paramsSchema as postTicketCommentParams } from "../workflows/blocks/post-ticket-comment.js";
import { paramsSchema as postPrCommentParams } from "../workflows/blocks/post-pr-comment.js";
import { paramsSchema as humanQuestionParams } from "../workflows/blocks/human-question.js";
import { paramsSchema as arthurInjectionCheckParams } from "../workflows/blocks/arthur-injection-check.js";
import { paramsSchema as sendPlanApprovalParams } from "../workflows/blocks/send-plan-approval.js";
import {
  buildWorkflowBindingGraphContext,
  isSafeWorkflowInputName,
  isWorkflowBindingSource,
  validateWorkflowBindingIssues,
  type WorkflowBindingGraphContext,
} from "./bindings.js";
import {
  resolveWorkflowBlockContract,
  workflowBlockDeploymentDefinitionIssues,
  workflowBlockDefinitionIssues,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";
import { analyzeWorkflowV2Bindings } from "./available-values.js";
import { validateTransformDefinition } from "./transform.js";
import { v2BranchConditionComplexityMessage } from "./v2-branch.js";
import { validateWorkflowV2WorkspaceAccessIssues } from "./workspace-access.js";

const nodeId = z.string().trim().min(1);
const coordinate = z.number().finite();
const bindingSource = z.custom<WorkflowBindingSource>(
  (source) => typeof source === "string" && isWorkflowBindingSource(source),
  { message: "Binding source must start with trigger.*, steps.<nodeId>.output.*, or run.*." },
);
const bindingInputName = z.custom<string>(
  (name) => typeof name === "string" && isSafeWorkflowInputName(name),
  { message: "Input name contains an empty or unsafe path segment." },
);

const promptSourceRefSchema = z
  .object({
    promptId: z.number().int().positive(),
    version: z.number().int().positive(),
    insertedHash: z.string().max(16).optional(),
  })
  .strict();

const baseNodeFields = {
  id: nodeId,
  name: z.string().optional(),
  x: coordinate,
  y: coordinate,
  promptRefs: z.record(z.string().min(1).max(64), promptSourceRefSchema).optional(),
  inputs: z.record(bindingInputName, bindingSource).default({}),
};

const emptyParams = z.object({}).strict();
const agentParams = z
  .object({
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:\/-]+$/).optional(),
    provider: z.enum(["claude", "codex"]).optional(),
    prompt: z.string().trim().min(1).max(50000).optional(),
  })
  .strict();

const vcsProviders = z.enum(["github", "gitlab"]);
const vcsProviderSelection = z.array(vcsProviders).min(1);
const reviewStates = z.enum(["changes_requested", "commented"]);
const prTriggerScope = z.enum(["workflow_owned", "any"]);

const triggerNode = z
  .object({ ...baseNodeFields, type: z.literal("trigger_ticket_ai"), params: emptyParams })
  .strict();

const triggerPlanApprovedNode = z
  .object({ ...baseNodeFields, type: z.literal("trigger_plan_approved"), params: emptyParams })
  .strict();

const triggerPrCreatedNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("trigger_pr_created"),
    params: z
      .object({
        providers: vcsProviderSelection.default(["github", "gitlab"]),
        scope: prTriggerScope.default("workflow_owned"),
      })
      .strict(),
  })
  .strict();

const triggerPrChecksFailedNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("trigger_pr_checks_failed"),
    params: z
      .object({
        providers: vcsProviderSelection.default(["github", "gitlab"]),
        scope: prTriggerScope.default("workflow_owned"),
        checkNames: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
        githubAppSlugs: z
          .array(z.string().trim().min(1).max(100))
          .min(1)
          .max(20)
          .default(["github-actions"]),
        gitlabPipelineSources: z
          .array(z.string().trim().min(1).max(100))
          .min(1)
          .max(20)
          .default(["merge_request_event"]),
      })
      .strict(),
  })
  .strict();

// on: which submitted review states may trigger a run. Defaults to GitHub
// ["changes_requested"] only — a "commented" review carries an untrusted body
// that fix_agent would feed to a full-permission agent, so operators must opt in
// to "commented" explicitly.
const triggerPrReviewNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("trigger_pr_review"),
    params: z
      .object({
        providers: vcsProviderSelection.default(["github"]),
        on: z.array(reviewStates).min(1).default(["changes_requested"]),
        scope: prTriggerScope.default("workflow_owned"),
      })
      .strict(),
  })
  .strict();

const triggerPrMergedNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("trigger_pr_merged"),
    params: z
      .object({
        providers: vcsProviderSelection.default(["github", "gitlab"]),
        scope: prTriggerScope.default("workflow_owned"),
      })
      .strict(),
  })
  .strict();

const planningNode = z
  .object({ ...baseNodeFields, type: z.literal("planning_agent"), params: agentParams })
  .strict();

const implementationNode = z
  .object({ ...baseNodeFields, type: z.literal("implementation_agent"), params: agentParams })
  .strict();

const reviewNode = z
  .object({ ...baseNodeFields, type: z.literal("review_agent"), params: agentParams })
  .strict();

const runPrePrChecksNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("run_pre_pr_checks"),
    params: z
      .object({ maxFixCycles: z.number().int().min(0).max(5).optional() })
      .strict(),
  })
  .strict();

const openPrNode = z
  .object({ ...baseNodeFields, type: z.literal("open_pr"), params: emptyParams })
  .strict();

const updateTicketStatusNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("update_ticket_status"),
    params: z.object({ target: z.string().trim().min(1).max(200) }).strict(),
  })
  .strict();

const prepareWorkspaceNode = z
  .object({ ...baseNodeFields, type: z.literal("prepare_workspace"), params: prepareWorkspaceParams })
  .strict();

const finalizeWorkspaceNode = z
  .object({ ...baseNodeFields, type: z.literal("finalize_workspace"), params: finalizeWorkspaceParams })
  .strict();

const fixAgentNode = z
  .object({ ...baseNodeFields, type: z.literal("fix_agent"), params: fixAgentParams })
  .strict();

const genericAgentNode = z
  .object({ ...baseNodeFields, type: z.literal("generic_agent"), params: genericAgentParams })
  .strict();

const callLlmNode = z
  .object({ ...baseNodeFields, type: z.literal("call_llm"), params: callLlmParams })
  .strict();

const fetchPrContextNode = z
  .object({ ...baseNodeFields, type: z.literal("fetch_pr_context"), params: fetchPrContextParams })
  .strict();

const runChecksNode = z
  .object({ ...baseNodeFields, type: z.literal("run_checks"), params: runChecksParams })
  .strict();

const postTicketCommentNode = z
  .object({ ...baseNodeFields, type: z.literal("post_ticket_comment"), params: postTicketCommentParams })
  .strict();

const postPrCommentNode = z
  .object({ ...baseNodeFields, type: z.literal("post_pr_comment"), params: postPrCommentParams })
  .strict();

const humanQuestionNode = z
  .object({ ...baseNodeFields, type: z.literal("human_question"), params: humanQuestionParams })
  .strict();

const arthurInjectionCheckNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("arthur_injection_check"),
    params: arthurInjectionCheckParams,
  })
  .strict();

const sendSlackMessageNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("send_slack_message"),
    params: z
      .object({
        message: z.string().trim().max(2000).optional(),
        sendOn: z.enum(["pr_ready", "always"]).optional(),
      })
      .strict(),
  })
  .strict();

const sendPlanApprovalNode = z
  .object({ ...baseNodeFields, type: z.literal("send_plan_approval"), params: sendPlanApprovalParams })
  .strict();

const branchNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("branch"),
    params: z.object({ condition: z.string().trim().min(1).max(1000) }).strict(),
  })
  .strict();

const loopNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("loop"),
    params: z
      .object({
        maxAttempts: z.number().int().min(1).max(20),
        onExhaust: z.enum(["fail", "human", "continue"]),
      })
      .strict(),
  })
  .strict();

const terminateNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("terminate"),
    params: z
      .object({
        terminalStatus: z.enum(["waiting_for_human", "failed", "skipped", "done"]),
        postComment: z.string().trim().min(1).max(2000).optional(),
      })
      .strict(),
  })
  .strict();

const nodeSchema = z.discriminatedUnion("type", [
  triggerNode,
  triggerPlanApprovedNode,
  triggerPrCreatedNode,
  triggerPrChecksFailedNode,
  triggerPrReviewNode,
  triggerPrMergedNode,
  planningNode,
  implementationNode,
  reviewNode,
  fixAgentNode,
  genericAgentNode,
  prepareWorkspaceNode,
  finalizeWorkspaceNode,
  runPrePrChecksNode,
  runChecksNode,
  callLlmNode,
  fetchPrContextNode,
  openPrNode,
  updateTicketStatusNode,
  postTicketCommentNode,
  postPrCommentNode,
  sendSlackMessageNode,
  sendPlanApprovalNode,
  humanQuestionNode,
  arthurInjectionCheckNode,
  branchNode,
  loopNode,
  terminateNode,
]);

const edgeSchema = z
  .object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    fromPort: z.string().trim().min(1).optional(),
  })
  .strict();

// Sized far above any hand-drawn workflow (the built-in default is 8 blocks/7
// connections) but low enough to bound validateWorkflowGraph, whose dominator
// fixpoint is O(N^2*E) and copies the node universe per node.
const MAX_NODES = 200;
const MAX_EDGES = 400;
const executionBudgetsSchema = z
  .object({
    maxDurationMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().finite().positive().optional(),
  })
  .strict();

export const workflowDefinitionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    budgets: executionBudgetsSchema.optional(),
    nodes: z.array(nodeSchema).max(MAX_NODES, `Workflow cannot have more than ${MAX_NODES} blocks.`),
    edges: z
      .array(edgeSchema)
      .max(MAX_EDGES, `Workflow cannot have more than ${MAX_EDGES} connections.`),
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
    segments.length < 4 ||
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

const workflowInputBindingV2Schema = z.discriminatedUnion(
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
    z.object({ kind: z.literal("literal"), value: jsonValueSchema }).strict(),
  ],
);

// Transform shape parsing deliberately preserves semantically incomplete
// drafts. Unsafe/empty names and paths are deployment issues reported by the
// Transform validator, so Save can retain an in-progress visual configuration.
const transformDraftNameSchema = z.string().max(200);
const transformPathSegmentSchema = z.string().max(200);
const transformInputPathSchema = z
  .object({
    input: transformDraftNameSchema,
    path: z.array(transformPathSegmentSchema).max(50),
  })
  .strict();
const transformMapValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("input"),
      source: transformInputPathSchema,
      defaultValue: jsonValueSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("literal"), value: jsonValueSchema }).strict(),
]);
const transformMapFieldSchema = z
  .object({
    name: transformDraftNameSchema,
    value: transformMapValueSchema,
  })
  .strict();
const transformComparisonOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
]);
const transformPredicateSchema: z.ZodType<TransformPredicate> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("comparison"),
        path: z.array(transformPathSegmentSchema).max(50),
        operator: transformComparisonOperatorSchema,
        value: jsonValueSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("is_null"),
        path: z.array(transformPathSegmentSchema).max(50),
        isNull: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("all"),
        predicates: z.array(transformPredicateSchema).max(50),
      })
      .strict(),
    z
      .object({
        kind: z.literal("any"),
        predicates: z.array(transformPredicateSchema).max(50),
      })
      .strict(),
    z.object({ kind: z.literal("not"), predicate: transformPredicateSchema }).strict(),
  ]),
);
const transformConfigurationSchema: z.ZodType<TransformConfiguration> = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("map_object"),
        fields: z.array(transformMapFieldSchema).max(100),
      })
      .strict(),
    z
      .object({
        operation: z.literal("filter_array"),
        source: transformInputPathSchema,
        predicate: transformPredicateSchema,
      })
      .strict(),
  ],
);

const v2TriggerPrCreatedConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: prTriggerScope.default("workflow_owned"),
  })
  .strict();
const v2TriggerPrChecksFailedConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: prTriggerScope.default("workflow_owned"),
    checkNames: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    githubAppSlugs: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .default(["github-actions"]),
    gitlabPipelineSources: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .default(["merge_request_event"]),
  })
  .strict();
const v2TriggerPrReviewConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github"]),
    on: z.array(reviewStates).min(1).default(["changes_requested"]),
    scope: prTriggerScope.default("workflow_owned"),
  })
  .strict();
const v2TriggerPrMergedConfiguration = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: prTriggerScope.default("workflow_owned"),
  })
  .strict();
const v2RunPrePrChecksConfiguration = z
  .object({ maxFixCycles: z.number().int().min(0).max(5).optional() })
  .strict();
const v2OpenPrConfiguration = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
  })
  .strict();
const v2UpdateTicketStatusConfiguration = z
  .object({ target: z.string().trim().min(1).max(200) })
  .strict();
const v2SendSlackMessageConfiguration = z
  .object({
    message: z.string().trim().max(2000).optional(),
    sendOn: z.enum(["pr_ready", "always"]).optional(),
  })
  .strict();
const v2LoopConfiguration = z
  .object({
    maxAttempts: z.number().int().min(1).max(20),
    onExhaust: z.enum(["fail", "human", "continue"]),
  })
  .strict();
const v2TerminateConfiguration = z
  .object({
    terminalStatus: z.enum([
      "waiting_for_human",
      "failed",
      "skipped",
      "done",
    ]),
    postComment: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

/** The v2 runtime consumes the same code-owned configuration surface as the
 * corresponding v1 executor. Transform and Branch intentionally use their own
 * typed configuration validators below. */
const v2ConfigurationSchemas = {
  trigger_ticket_ai: emptyParams,
  trigger_plan_approved: emptyParams,
  trigger_pr_created: v2TriggerPrCreatedConfiguration,
  trigger_pr_checks_failed: v2TriggerPrChecksFailedConfiguration,
  trigger_pr_review: v2TriggerPrReviewConfiguration,
  trigger_pr_merged: v2TriggerPrMergedConfiguration,
  planning_agent: agentParams,
  implementation_agent: agentParams,
  review_agent: agentParams,
  fix_agent: fixAgentParams,
  generic_agent: genericAgentParams,
  prepare_workspace: prepareWorkspaceParams,
  finalize_workspace: finalizeWorkspaceParams,
  run_pre_pr_checks: v2RunPrePrChecksConfiguration,
  run_checks: runChecksParams,
  call_llm: callLlmParams,
  fetch_pr_context: fetchPrContextParams,
  open_pr: v2OpenPrConfiguration,
  update_ticket_status: v2UpdateTicketStatusConfiguration,
  post_ticket_comment: postTicketCommentParams,
  post_pr_comment: postPrCommentParams,
  send_slack_message: v2SendSlackMessageConfiguration,
  send_plan_approval: sendPlanApprovalParams,
  human_question: humanQuestionParams,
  arthur_injection_check: arthurInjectionCheckParams,
  loop: v2LoopConfiguration,
  terminate: v2TerminateConfiguration,
} satisfies Record<
  Exclude<WorkflowBlockType, "branch" | "transform">,
  z.ZodTypeAny
>;

const v2BranchLiteralOperandSchema = z
  .object({
    kind: z.literal("lit"),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  })
  .strict();
const v2BranchPathOperandSchema = z
  .object({
    kind: z.literal("path"),
    reference: z.custom<WorkflowDataReferenceV2>(
      (value) => isWorkflowDataReferenceV2(value),
      { message: "Branch paths must use a canonical v2 data reference." },
    ),
  })
  .strict();
const v2BranchOperandSchema = z.discriminatedUnion("kind", [
  v2BranchLiteralOperandSchema,
  v2BranchPathOperandSchema,
]);
const v2BranchBooleanAstSchema: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("lit"), value: z.boolean() }).strict(),
    v2BranchPathOperandSchema,
    z
      .object({
        kind: z.literal("not"),
        operand: v2BranchBooleanAstSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("and"),
        left: v2BranchBooleanAstSchema,
        right: v2BranchBooleanAstSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("or"),
        left: v2BranchBooleanAstSchema,
        right: v2BranchBooleanAstSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("eq"),
        left: v2BranchOperandSchema,
        right: v2BranchOperandSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("neq"),
        left: v2BranchOperandSchema,
        right: v2BranchOperandSchema,
      })
      .strict(),
  ]),
);
const v2BranchConfigurationSchema = z
  .object({ condition: v2BranchBooleanAstSchema })
  .strict();

type V2BranchPathOperand = WorkflowBranchPathOperandV2;
type V2BranchOperand = WorkflowBranchOperandV2;
type V2BranchBooleanAst = WorkflowBranchBooleanAstV2;

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

export const workflowDefinitionV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    budgets: executionBudgetsSchema.optional(),
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

export const workflowDefinitionSchema = z.union([
  workflowDefinitionV1Schema,
  workflowDefinitionV2Schema,
]);

// Ordinary version reads deliberately do not apply current block-param or
// graph rules: operators must be able to open and repair an old invalid graph.
// This narrower schema validates only the stable persisted envelope and
// performs deterministic shape upgrades such as adding node.inputs.
const storedWorkflowParamValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
type StoredWorkflowBlockType = WorkflowBlockTypeV1 | "arthur_trace";

const storedWorkflowBlockType = z.custom<StoredWorkflowBlockType>(
  (type) =>
    type === "arthur_trace" ||
    (typeof type === "string" &&
      type !== "transform" &&
      Object.prototype.hasOwnProperty.call(BLOCK_TYPE_SPECS, type)),
  { message: "Unknown workflow block type." },
);
const storedWorkflowNode = z
  .object({
    id: nodeId,
    type: storedWorkflowBlockType,
    name: z.string().optional(),
    x: coordinate,
    y: coordinate,
    // Two-arg record: the nitro bundle resolves bare "zod" to zod 4, where a
    // single-arg record means record(KEY) with an undefined value schema that
    // only crashes at parse time (500 on every stored-definition read).
    params: z.record(z.string(), storedWorkflowParamValue),
    inputs: z.record(bindingInputName, bindingSource).optional(),
  })
  .passthrough();
const storedWorkflowDefinitionV1 = z
  .object({
    schemaVersion: z.literal(1),
    budgets: executionBudgetsSchema.optional(),
    nodes: z.array(storedWorkflowNode),
    edges: z.array(edgeSchema),
  })
  .passthrough();

function legacyFinalizeIdBase(openPrId: string): string {
  const safeOpenPrId = openPrId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safeOpenPrId || "open-pr"}-finalize`;
}

function insertLegacyOpenPrFinalizers(
  nodes: WorkflowDefinitionV1Node[],
  edges: WorkflowDefinitionV1Edge[],
): { nodes: WorkflowDefinitionV1Node[]; edges: WorkflowDefinitionV1Edge[] } {
  const usedIds = new Set(nodes.map((node) => node.id));
  const finalizeByOpenPr = new Map<string, string>();
  const upgradedNodes: WorkflowDefinitionV1Node[] = [];

  for (const node of nodes) {
    if (
      node.type !== "open_pr" ||
      Object.prototype.hasOwnProperty.call(node.inputs, "repositories")
    ) {
      upgradedNodes.push(node);
      continue;
    }

    const base = legacyFinalizeIdBase(node.id);
    let finalizeId = base;
    for (let suffix = 2; usedIds.has(finalizeId); suffix += 1) {
      finalizeId = `${base}-${suffix}`;
    }
    usedIds.add(finalizeId);
    finalizeByOpenPr.set(node.id, finalizeId);
    upgradedNodes.push(
      {
        id: finalizeId,
        type: "finalize_workspace",
        x: node.x - 220,
        y: node.y,
        params: {},
        inputs: {},
      },
      {
        ...node,
        inputs: {
          ...node.inputs,
          repositories: `steps.${finalizeId}.output.repositories`,
        },
      },
    );
  }

  if (finalizeByOpenPr.size === 0) return { nodes, edges };
  return {
    nodes: upgradedNodes,
    edges: [
      ...edges.map((edge) => {
        const finalizeId = finalizeByOpenPr.get(edge.to);
        return finalizeId ? { ...edge, to: finalizeId } : edge;
      }),
      ...[...finalizeByOpenPr].map(([openPrId, finalizeId]) => ({
        from: finalizeId,
        to: openPrId,
      })),
    ],
  };
}

function upgradeStoredWorkflowDefinitionV1(raw: unknown): WorkflowDefinitionV1 {
  const parsed = storedWorkflowDefinitionV1.parse(raw);
  const storedNodeById = new Map(parsed.nodes.map((node) => [node.id, node]));
  const retiredNodeIds = new Set(
    parsed.nodes.filter((node) => node.type === "arthur_trace").map((node) => node.id),
  );

  const resolveNormalTargets = (nodeId: string, seen: Set<string>): string[] => {
    if (!retiredNodeIds.has(nodeId)) return [nodeId];
    if (seen.has(nodeId)) return [];

    const nextSeen = new Set(seen).add(nodeId);
    return parsed.edges
      .filter(
        (edge) =>
          edge.from === nodeId && (edge.fromPort === undefined || edge.fromPort === "out"),
      )
      .flatMap((edge) => resolveNormalTargets(edge.to, nextSeen));
  };

  const edges = parsed.edges.flatMap((edge) => {
    if (retiredNodeIds.has(edge.from)) return [];
    return resolveNormalTargets(edge.to, new Set()).map((to) => ({
      from: edge.from,
      to,
      ...(edge.fromPort === undefined ? {} : { fromPort: edge.fromPort }),
    }));
  });

  const nodes: WorkflowDefinitionV1Node[] = [];
  const requiredChecksByFinalize = new Map<string, string[]>();
  for (const node of parsed.nodes) {
    if (node.type === "arthur_trace") continue;
    const params = { ...node.params };
    const inputs = { ...(node.inputs ?? {}) };
    if (node.type === "generic_agent" && params.workspaceMode === undefined) {
      params.workspaceMode = "read_write";
    }
    if (
      node.type === "trigger_pr_created" ||
      node.type === "trigger_pr_checks_failed" ||
      node.type === "trigger_pr_review" ||
      node.type === "trigger_pr_merged"
    ) {
      if (params.scope !== "workflow_owned" && params.scope !== "any") {
        params.scope = params.onlyWorkflowOwned === false ? "any" : "workflow_owned";
      }
      delete params.onlyWorkflowOwned;
    }
    if (
      node.type === "trigger_pr_review" &&
      Array.isArray(params.on) &&
      params.on.length === 0
    ) {
      params.on = ["changes_requested"];
    }
    if (node.type === "send_plan_approval") {
      const sourceId = params.planFromStep;
      if (typeof sourceId === "string" && sourceId.length > 0) {
        inputs.plan ??= `steps.${sourceId}.output.plan`;
      }
      delete params.planFromStep;
    }
    if (node.type === "arthur_injection_check") {
      delete params.legacyContentFromStep;
      const sourceId = params.contentFromStep;
      if (typeof sourceId === "string" && sourceId.length > 0 && inputs.content === undefined) {
        const sourceNode = storedNodeById.get(sourceId);
        const sourceType = sourceNode?.type;
        const declaredOutputSchema = sourceNode?.params.outputSchema;
        const usesDeclaredOutputSchema =
          (sourceType === "generic_agent" || sourceType === "call_llm") &&
          typeof declaredOutputSchema === "string" &&
          declaredOutputSchema.trim().length > 0;
        const field =
          sourceType === "planning_agent"
            ? "plan"
            : sourceType === "generic_agent" && !usesDeclaredOutputSchema
              ? "body"
              : sourceType === "call_llm" && !usesDeclaredOutputSchema
                ? "output"
                : null;
        if (field) {
          inputs.content = `steps.${sourceId}.output.${field}`;
        }
      }
      delete params.contentFromStep;
    }
    if (node.type === "finalize_workspace") {
      const requiredChecks = params.requiredChecks;
      if (Array.isArray(requiredChecks)) {
        requiredChecksByFinalize.set(node.id, requiredChecks);
      }
      delete params.requiredChecks;
    }
    nodes.push({
      id: node.id,
      type: node.type,
      ...(node.name === undefined ? {} : { name: node.name }),
      x: node.x,
      y: node.y,
      params,
      inputs,
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const normalPredecessors = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.fromPort !== undefined && edge.fromPort !== "out") continue;
    const predecessors = normalPredecessors.get(edge.to) ?? [];
    predecessors.push(edge.from);
    normalPredecessors.set(edge.to, predecessors);
  }
  const onlyNormalPredecessor = (nodeId: string): WorkflowDefinitionV1Node | undefined => {
    const predecessors = normalPredecessors.get(nodeId) ?? [];
    return predecessors.length === 1 ? nodeById.get(predecessors[0]) : undefined;
  };
  const canonicalBindingNodes = nodes.map((node): WorkflowDefinitionV1Node => {
    const predecessor = onlyNormalPredecessor(node.id);
    if (node.type === "planning_agent" && predecessor?.type === "trigger_ticket_ai") {
      return {
        ...node,
        inputs: {
          ticket: "trigger.ticket",
          comments: "trigger.comments",
          priorAnswers: "trigger.priorAnswers",
          ...node.inputs,
        },
      };
    }
    if (node.type !== "implementation_agent") return node;

    if (predecessor?.type === "trigger_plan_approved") {
      return {
        ...node,
        inputs: {
          ticket: "trigger.ticket",
          plan: "trigger.approvedPlan",
          ...node.inputs,
        },
      };
    }
    if (predecessor?.type !== "planning_agent") return node;

    const planningTrigger = onlyNormalPredecessor(predecessor.id);
    return {
      ...node,
      inputs: {
        ...(planningTrigger?.type === "trigger_ticket_ai"
          ? { ticket: "trigger.ticket" as const }
          : {}),
        plan: `steps.${predecessor.id}.output.plan`,
        ...node.inputs,
      },
    };
  });

  const publicationUpgraded = insertLegacyOpenPrFinalizers(canonicalBindingNodes, edges);
  const intermediate: WorkflowDefinitionV1 = {
    schemaVersion: 1,
    nodes: publicationUpgraded.nodes,
    edges: publicationUpgraded.edges,
  };
  const graphContext = buildWorkflowBindingGraphContext(intermediate);
  const upgradedNodes = publicationUpgraded.nodes.map((node): WorkflowDefinitionV1Node => {
    if (node.type !== "finalize_workspace") return node;

    const params = { ...node.params };
    const inputs = { ...node.inputs };
    delete params.legacyRequiredChecks;

    for (const sourceId of requiredChecksByFinalize.get(node.id) ?? []) {
      const inputName = `checks.${sourceId}`;
      const source = `steps.${sourceId}.output.status`;
      const canBind =
        sourceId !== node.id &&
        graphContext.nodeById.has(sourceId) &&
        (graphContext.dominators.get(node.id)?.has(sourceId) ?? false) &&
        isSafeWorkflowInputName(inputName) &&
        isWorkflowBindingSource(source) &&
        (inputs[inputName] === undefined || inputs[inputName] === source);
      if (canBind) {
        inputs[inputName] ??= source;
      }
    }

    return { ...node, params, inputs };
  });

  return {
    schemaVersion: 1,
    ...(parsed.budgets === undefined ? {} : { budgets: parsed.budgets }),
    nodes: upgradedNodes,
    edges: publicationUpgraded.edges,
  };
}

/** Reads preserve the stored schema version. Only v1 snapshots receive the
 * deterministic compatibility upgrades required by the legacy interpreter. */
export function upgradeStoredWorkflowDefinition(
  raw: WorkflowDefinitionV1,
): WorkflowDefinitionV1;
export function upgradeStoredWorkflowDefinition(
  raw: WorkflowDefinitionV2,
): WorkflowDefinitionV2;
export function upgradeStoredWorkflowDefinition(
  raw: { schemaVersion: 1; nodes: unknown; edges: unknown },
): WorkflowDefinitionV1;
export function upgradeStoredWorkflowDefinition(
  raw: { schemaVersion: 2; nodes: unknown; edges: unknown },
): WorkflowDefinitionV2;
export function upgradeStoredWorkflowDefinition(raw: unknown): WorkflowDefinition;
export function upgradeStoredWorkflowDefinition(raw: unknown): WorkflowDefinition {
  if (
    raw !== null &&
    typeof raw === "object" &&
    "schemaVersion" in raw &&
    (raw as { schemaVersion?: unknown }).schemaVersion === 2
  ) {
    return workflowDefinitionV2Schema.parse(raw);
  }
  return upgradeStoredWorkflowDefinitionV1(raw);
}

type AssertAssignable<T extends WorkflowDefinition> = T;
export type WorkflowDefinitionGuard = AssertAssignable<z.infer<typeof workflowDefinitionSchema>>;

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
      const frame = stack[stack.length - 1];
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
      const frame = work[work.length - 1];
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
          const parent = work[work.length - 1].node;
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

/**
 * Compute the dominator set of every node reachable from a trigger.
 *
 * D dominates N when every path from the entry to N passes through D. The
 * multiple triggers are modelled as a single virtual entry (each trigger's only
 * predecessor), so a block dominates N only if it lies on every path from *any*
 * trigger to N. Loop back-edges are left in `predecessors` (they arrive via the
 * reverse adjacency); the classic iterative fixpoint below handles the resulting
 * cycles, so a block inside a loop dominates a later node only when it is
 * unavoidable regardless of how many times the loop iterates.
 *
 * Returns a map from node id to its dominators (always including the node
 * itself). Nodes unreachable from a trigger are omitted.
 */
function computeDominators(
  entries: string[],
  reachable: Set<string>,
  predecessors: Map<string, string[]>,
): Map<string, Set<string>> {
  const entrySet = new Set(entries.filter((id) => reachable.has(id)));
  const universe = [...reachable];
  const dominators = new Map<string, Set<string>>();
  for (const id of universe) {
    // An entry is dominated only by itself; every other node starts with the
    // full universe and is narrowed by intersecting its predecessors' sets.
    dominators.set(id, entrySet.has(id) ? new Set([id]) : new Set(universe));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of universe) {
      if (entrySet.has(id)) continue;
      const preds = (predecessors.get(id) ?? []).filter((pred) => reachable.has(pred));
      let next: Set<string> | null = null;
      for (const pred of preds) {
        const predDom = dominators.get(pred)!;
        if (next === null) {
          next = new Set(predDom);
        } else {
          for (const candidate of [...next]) {
            if (!predDom.has(candidate)) next.delete(candidate);
          }
        }
      }
      if (next === null) next = new Set();
      next.add(id);
      const current = dominators.get(id)!;
      if (next.size !== current.size || [...next].some((entry) => !current.has(entry))) {
        dominators.set(id, next);
        changed = true;
      }
    }
  }

  return dominators;
}

export function validateWorkflowGraph(
  def: WorkflowDefinition,
  bindingGraphContext?: WorkflowBindingGraphContext,
): string[] {
  return validateWorkflowGraphIssues(def, bindingGraphContext).map(({ message }) => message);
}

export function validateWorkflowGraphIssues(
  def: WorkflowDefinition,
  bindingGraphContext?: WorkflowBindingGraphContext,
): WorkflowDefinitionValidationIssue[] {
  return def.schemaVersion === 1
    ? validateWorkflowGraphV1Issues(def, bindingGraphContext)
    : validateWorkflowGraphV2Issues(def);
}

function validateWorkflowGraphV1Issues(
  def: WorkflowDefinitionV1,
  bindingGraphContext?: WorkflowBindingGraphContext,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const addIssue = (message: string, nodeId: string | null = null, path?: string) => {
    issues.push({
      code: "deployment",
      severity: "error",
      nodeId,
      ...(path ? { path } : {}),
      message,
    });
  };
  const { nodes, edges } = def;

  const nodeById = new Map<string, WorkflowDefinitionV1Node>();
  for (const [nodeIndex, node] of nodes.entries()) {
    if (nodeById.has(node.id)) {
      addIssue(
        `Block id "${node.id}" is used more than once.`,
        node.id,
        `/nodes/${nodeIndex}/id`,
      );
    }
    nodeById.set(node.id, node);
  }

  const nodeIds = nodes.map((node) => node.id);
  const triggerNodes = nodes.filter((node) => isTriggerBlockType(node.type));

  if (triggerNodes.length === 0) {
    addIssue("Workflow must contain at least one trigger block.", null, "/nodes");
  }

  const triggerTypeCounts = new Map<WorkflowBlockType, number>();
  for (const node of triggerNodes) {
    triggerTypeCounts.set(node.type, (triggerTypeCounts.get(node.type) ?? 0) + 1);
  }
  for (const [type, count] of triggerTypeCounts) {
    if (count > 1) {
      addIssue(`Workflow contains more than one ${type} trigger block.`, null, "/nodes");
    }
  }

  const graphEdges: GraphEdge[] = [];
  for (const [edgeIndex, edge] of edges.entries()) {
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

    const spec = BLOCK_TYPE_SPECS[fromNode.type];
    if (spec.ports.length === 0) {
      addIssue(
        `Terminal block "${edge.from}" (${fromNode.type}) cannot have outgoing connections.`,
        edge.from,
        `/edges/${edgeIndex}`,
      );
      continue;
    }
    const resolvedPort = edge.fromPort ?? spec.ports[0];
    if (!wirablePorts(fromNode.type).includes(resolvedPort)) {
      addIssue(
        `Connection from "${edge.from}" uses unknown port "${resolvedPort}" of block type ${fromNode.type}.`,
        edge.from,
        `/edges/${edgeIndex}/fromPort`,
      );
    } else if (edge.fromPort === undefined && spec.ports.length > 1) {
      const label = fromNode.type === "loop" ? "loop" : "branch";
      addIssue(
        `Connection from ${label} "${edge.from}" must specify a port (${spec.ports.join("/")}).`,
        edge.from,
        `/edges/${edgeIndex}/fromPort`,
      );
    }
    graphEdges.push({ from: edge.from, to: edge.to, port: resolvedPort, fromType: fromNode.type });
  }

  const exactSeen = new Set<string>();
  const portTargets = new Map<string, Set<string>>();
  for (const edge of graphEdges) {
    const portKey = `${edge.from}\0${edge.port}`;
    const exactKey = `${portKey}\0${edge.to}`;
    if (exactSeen.has(exactKey)) {
      addIssue(`Duplicate connection from "${edge.from}" to "${edge.to}".`, edge.from, "/edges");
      continue;
    }
    exactSeen.add(exactKey);
    const targets = portTargets.get(portKey);
    if (targets) {
      addIssue(
        `Block "${edge.from}" has multiple connections from port "${edge.port}".`,
        edge.from,
        "/edges",
      );
      targets.add(edge.to);
    } else {
      portTargets.set(portKey, new Set([edge.to]));
    }
  }

  const incoming = new Map<string, number>();
  for (const edge of graphEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  for (const node of triggerNodes) {
    if ((incoming.get(node.id) ?? 0) > 0) {
      addIssue(`The trigger block "${node.id}" must not have incoming connections.`, node.id);
    }
  }

  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const forwardNoLoopBack = new Map<string, string[]>();
  const portsOut = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    forward.set(id, []);
    reverse.set(id, []);
    forwardNoLoopBack.set(id, []);
  }
  for (const edge of graphEdges) {
    forward.get(edge.from)!.push(edge.to);
    reverse.get(edge.to)!.push(edge.from);
    if (!(edge.fromType === "loop" && edge.port === "continue")) {
      forwardNoLoopBack.get(edge.from)!.push(edge.to);
    }
    const used = portsOut.get(edge.from) ?? new Set<string>();
    used.add(edge.port);
    portsOut.set(edge.from, used);
  }

  const reachable = reachableFrom(
    triggerNodes.map((node) => node.id),
    forward,
  );
  for (const node of nodes) {
    if (!isTriggerBlockType(node.type) && !reachable.has(node.id)) {
      addIssue(`Block "${node.id}" is not reachable from a trigger.`, node.id);
    }
  }

  for (const node of nodes) {
    if (node.type === "branch") {
      const used = portsOut.get(node.id) ?? new Set<string>();
      if (!used.has("true")) {
        addIssue(`Branch "${node.id}" must have its "true" port connected.`, node.id);
      }
      if (!used.has("false")) {
        addIssue(`Branch "${node.id}" must have its "false" port connected.`, node.id);
      }
    } else if (node.type === "loop") {
      const used = portsOut.get(node.id) ?? new Set<string>();
      if (!used.has("continue")) {
        addIssue(`Loop "${node.id}" must have its "continue" port connected.`, node.id);
      }
      if (node.params.onExhaust === "continue" && !used.has("exhausted")) {
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

  const acyclicCycle = findCycle(forwardNoLoopBack, nodeIds);
  if (acyclicCycle) {
    const rendered = acyclicCycle.map((id) => `"${id}"`).join(" -> ");
    addIssue(`Blocks ${rendered} form a cycle that does not pass through a Loop block.`);
  }

  for (const component of stronglyConnectedComponents(forward, nodeIds)) {
    if (component.length <= 1) continue;
    const loopCount = component.filter((id) => nodeById.get(id)?.type === "loop").length;
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

  const finalizeNodes = nodes.filter((node) => node.type === "finalize_workspace");
  for (const finalize of finalizeNodes) {
    const downstream = reachableFrom(forward.get(finalize.id) ?? [], forward);
    for (const laterFinalize of finalizeNodes) {
      if (laterFinalize.id === finalize.id || !downstream.has(laterFinalize.id)) continue;
      addIssue(
        `Finalize Workspace block "${finalize.id}" can reach Finalize Workspace block "${laterFinalize.id}"; a workflow path may publish at most once.`,
        finalize.id,
      );
    }
  }

  const dominators =
    bindingGraphContext?.dominators ??
    computeDominators(
      triggerNodes.map((node) => node.id),
      reachable,
      reverse,
    );
  for (const node of nodes) {
    if (node.type !== "branch") continue;
    const condition = node.params.condition;
    if (typeof condition !== "string") continue;
    const parsed = parseCondition(condition);
    if (!parsed.ok) {
      addIssue(
        `Branch "${node.id}" has an invalid condition: ${parsed.error}.`,
        node.id,
        `/nodes/${nodes.indexOf(node)}/params/condition`,
      );
      continue;
    }
    // A referenced block must dominate this branch: every path from a trigger to
    // the branch has to pass through it, otherwise a run could reach the branch
    // without the block having produced an output. "An ancestor on some path" is
    // not enough (that was the bug) -- it has to be a strict dominator.
    const nodeDominators = dominators.get(node.id);
    for (const ref of parsed.refs) {
      const dominates =
        ref !== node.id && nodeById.has(ref) && (nodeDominators?.has(ref) ?? false);
      if (!dominates) {
        addIssue(
          `Branch "${node.id}" condition references block "${ref}" which does not run before it.`,
          node.id,
          `/nodes/${nodes.indexOf(node)}/params/condition`,
        );
      }
    }
  }

  return issues;
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
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    // Transform has a purpose-built shape and semantic validator. Keeping it
    // separate avoids accidentally accepting executor params as operations.
    if (node.type === "transform") continue;

    const allowedKeys = new Set(BLOCK_PARAM_KEYS[node.type]);
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

    if (node.type === "branch") {
      const complexityMessage = v2BranchConditionComplexityMessage(
        node.configuration.condition,
      );
      if (complexityMessage !== null) {
        issues.push(
          invalidConfigurationIssue(
            node,
            nodeIndex,
            ["condition"],
            complexityMessage,
          ),
        );
        continue;
      }
    }

    const schema =
      node.type === "branch"
        ? v2BranchConfigurationSchema
        : v2ConfigurationSchemas[node.type];
    const parsed = schema.safeParse(node.configuration);
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
): Record<string, WorkflowParamValue> {
  const parsedConfiguration =
    node.type === "branch" || node.type === "transform"
      ? null
      : v2ConfigurationSchemas[node.type].safeParse(node.configuration);
  const configuration =
    parsedConfiguration?.success === true
      ? (parsedConfiguration.data as Record<string, unknown>)
      : node.configuration;
  const params: Record<string, WorkflowParamValue> = {};
  for (const [name, value] of Object.entries(configuration)) {
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
  return params;
}

function validateWorkflowV2BlockDeploymentIssues(
  def: WorkflowDefinitionV2,
  registryContext: WorkflowBlockRegistryContext,
  options: { checkEnvironmentAvailability?: boolean },
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    const params = v2ConfigurationParams(node);
    if (
      node.type === "trigger_pr_checks_failed" &&
      !(Array.isArray(params.checkNames) && params.checkNames.length > 0)
    ) {
      issues.push(
        deploymentIssue(
          `Block "${node.id}" (trigger_pr_checks_failed) must configure at least one exact CI check name before deployment.`,
          node.id,
          `/nodes/${nodeIndex}/configuration/checkNames`,
        ),
      );
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
      const availability = resolveWorkflowBlockContract(
        node.type,
        params,
        registryContext,
      ).availability;
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
  return issues;
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
  availableValuesByNode: WorkflowAvailableValuesByNode,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    if (node.type !== "branch") continue;
    if (
      v2BranchConditionComplexityMessage(node.configuration.condition) !== null
    ) {
      continue;
    }
    const parsed = v2BranchConfigurationSchema.safeParse(node.configuration);
    if (!parsed.success) continue;

    const condition = parsed.data.condition as V2BranchBooleanAst;
    const catalog = new Map(
      (availableValuesByNode[node.id] ?? []).map((value) => [
        value.reference,
        value.schema,
      ]),
    );
    const addIssue = (
      relativePath: readonly (string | number)[],
      message: string,
    ) => {
      issues.push(
        invalidConfigurationIssue(node, nodeIndex, relativePath, message),
      );
    };
    const resolvePath = (
      operand: V2BranchPathOperand,
      path: readonly (string | number)[],
    ): JsonSchema202012 | null => {
      const schema = catalog.get(operand.reference);
      if (!schema) {
        addIssue(
          [...path, "reference"],
          `reference "${operand.reference}" is not guaranteed when this Branch runs.`,
        );
        return null;
      }
      return schema;
    };
    const operandSchema = (
      operand: V2BranchOperand,
      path: readonly (string | number)[],
    ): JsonSchema202012 | null =>
      operand.kind === "path" ? resolvePath(operand, path) : null;
    const validateComparison = (
      ast: Extract<V2BranchBooleanAst, { kind: "eq" | "neq" }>,
      path: readonly (string | number)[],
    ) => {
      const leftSchema = operandSchema(ast.left, [...path, "left"]);
      const rightSchema = operandSchema(ast.right, [...path, "right"]);
      const leftTypes =
        ast.left.kind === "lit"
          ? new Set([comparableTypeForLiteral(ast.left.value)])
          : leftSchema === null
            ? null
            : comparableTypesForSchema(leftSchema);
      const rightTypes =
        ast.right.kind === "lit"
          ? new Set([comparableTypeForLiteral(ast.right.value)])
          : rightSchema === null
            ? null
            : comparableTypesForSchema(rightSchema);

      if (
        ast.left.kind === "path" &&
        leftSchema !== null &&
        leftTypes === null
      ) {
        addIssue(
          [...path, "left", "reference"],
          `reference "${ast.left.reference}" does not have a scalar-comparable schema.`,
        );
      }
      if (
        ast.right.kind === "path" &&
        rightSchema !== null &&
        rightTypes === null
      ) {
        addIssue(
          [...path, "right", "reference"],
          `reference "${ast.right.reference}" does not have a scalar-comparable schema.`,
        );
      }

      if (
        ast.left.kind === "path" &&
        ast.right.kind === "lit" &&
        leftSchema !== null &&
        !schemaAllowsLiteral(leftSchema, ast.right.value)
      ) {
        addIssue(
          [...path, "right", "value"],
          `literal is incompatible with "${ast.left.reference}".`,
        );
      } else if (
        ast.left.kind === "lit" &&
        ast.right.kind === "path" &&
        rightSchema !== null &&
        !schemaAllowsLiteral(rightSchema, ast.left.value)
      ) {
        addIssue(
          [...path, "left", "value"],
          `literal is incompatible with "${ast.right.reference}".`,
        );
      } else if (
        leftTypes !== null &&
        rightTypes !== null &&
        ![...leftTypes].some((type) => rightTypes.has(type))
      ) {
        addIssue(path, "comparison operands have incompatible types.");
      }
    };
    const validateBoolean = (
      ast: V2BranchBooleanAst,
      path: readonly (string | number)[],
    ): void => {
      switch (ast.kind) {
        case "lit":
          return;
        case "path": {
          const schema = resolvePath(ast, path);
          const types = schema === null ? null : comparableTypesForSchema(schema);
          if (
            schema !== null &&
            (types === null || types.size !== 1 || !types.has("boolean"))
          ) {
            addIssue(
              [...path, "reference"],
              `reference "${ast.reference}" does not have a Boolean schema.`,
            );
          }
          return;
        }
        case "not":
          validateBoolean(ast.operand, [...path, "operand"]);
          return;
        case "and":
        case "or":
          validateBoolean(ast.left, [...path, "left"]);
          validateBoolean(ast.right, [...path, "right"]);
          return;
        case "eq":
        case "neq":
          validateComparison(ast, path);
          return;
      }
    };

    validateBoolean(condition, ["condition"]);
  }
  return issues;
}

function validateWorkflowGraphV2Issues(
  def: WorkflowDefinitionV2,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const addIssue = (message: string, nodeId: string | null = null, path?: string) => {
    issues.push(deploymentIssue(message, nodeId, path));
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

    if (node.type === "transform") {
      for (const inputName of Object.keys(node.inputs)) {
        issues.push({
          code: "unknown_input",
          severity: "error",
          nodeId: node.id,
          path: `/nodes/${nodeIndex}/inputs/${inputName}`,
          message: `Transform block "${node.id}" must declare "${inputName}" as an additional input with a schema.`,
        });
      }
      const configuration = transformConfigurationSchema.safeParse(node.configuration);
      if (configuration.success) {
        const inputSchemas = Object.fromEntries(
          node.additionalInputs.map((input) => [input.name, input.schema]),
        );
        issues.push(
          ...validateTransformDefinition({
            configuration: configuration.data,
            inputSchemas,
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
  registryContext: WorkflowBlockRegistryContext,
  options: {
    allowLegacyCompatibility?: boolean;
    checkEnvironmentAvailability?: boolean;
  } = {},
): string[] {
  return validateWorkflowDefinitionIssuesForDeployment(def, registryContext, options).map(
    ({ message }) => message,
  );
}

export function validateWorkflowDefinitionIssuesForDeployment(
  def: WorkflowDefinition,
  registryContext: WorkflowBlockRegistryContext,
  options: {
    allowLegacyCompatibility?: boolean;
    checkEnvironmentAvailability?: boolean;
  } = {},
): WorkflowDefinitionValidationIssue[] {
  if (def.schemaVersion === 2) {
    const bindingAnalysis = analyzeWorkflowV2Bindings(def, registryContext);
    const issues = dedupeDeploymentIssues([
      ...validateWorkflowGraphV2Issues(def),
      ...validateWorkflowV2ConfigurationIssues(def),
      ...validateWorkflowV2BlockDeploymentIssues(
        def,
        registryContext,
        options,
      ),
      ...bindingAnalysis.issues,
      ...validateWorkflowV2BranchConditionIssues(
        def,
        bindingAnalysis.availableValuesByNode,
      ),
      ...validateWorkflowV2WorkspaceAccessIssues(def),
    ]);
    return issues;
  }

  const graphContext = buildWorkflowBindingGraphContext(def);
  const issues = [
    ...validateWorkflowGraphIssues(def, graphContext),
    ...validateWorkflowBindingIssues(def, registryContext, graphContext),
    ...validateStaticFallbackInputIssues(def),
    // Existing deployed snapshots predate workspace-capability validation.
    // Keep those snapshots loadable; the affected executors still fail closed
    // before side effects when no workspace exists. New deployments retain the
    // strict producer requirement through the default validation path.
    ...(options.allowLegacyCompatibility
      ? []
      : validateWorkspaceCapabilityIssues(def, graphContext)),
    ...validateAnyScopeReviewSafetyIssues(def),
  ];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    if (!isWorkflowAddressablePathSegment(node.id)) {
      issues.push(
        deploymentIssue(
          `Block id "${node.id}" is not addressable; use a letter or underscore followed by letters, numbers, underscores, or hyphens.`,
          node.id,
          `/nodes/${nodeIndex}/id`,
        ),
      );
    }
    if (
      node.type === "trigger_pr_checks_failed" &&
      !(Array.isArray(node.params.checkNames) && node.params.checkNames.length > 0)
    ) {
      issues.push(
        deploymentIssue(
          `Block "${node.id}" (trigger_pr_checks_failed) must configure at least one exact CI check name before deployment.`,
          node.id,
          `/nodes/${nodeIndex}/params/checkNames`,
        ),
      );
    }
    const definitionIssues = options.allowLegacyCompatibility
      ? workflowBlockDefinitionIssues(node.type, node.params)
      : workflowBlockDeploymentDefinitionIssues(node.type, node.params);
    if (definitionIssues.length > 0) {
      issues.push(
        ...definitionIssues.map((issue) => ({
          code: issue.code,
          severity: "error" as const,
          nodeId: node.id,
          path: `/nodes/${nodeIndex}/params/outputSchema${issue.path}`,
          message: `Block "${node.id}" (${node.type}) is unavailable: ${issue.message}`,
        })),
      );
    } else if (options.checkEnvironmentAvailability !== false) {
      const availability = resolveWorkflowBlockContract(
        node.type,
        node.params,
        registryContext,
      ).availability;
      if (!availability.available) {
        issues.push(
          deploymentIssue(
            `Block "${node.id}" (${node.type}) is unavailable: ${availability.unavailableReason}`,
            node.id,
            `/nodes/${nodeIndex}/params`,
          ),
        );
      }
    }
  }
  return dedupeDeploymentIssues(issues);
}

function deploymentIssue(
  message: string,
  nodeId: string | null,
  path?: string,
): WorkflowDefinitionValidationIssue {
  return {
    code: "deployment",
    severity: "error",
    nodeId,
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

const STATIC_FALLBACK_INPUTS = {
  call_llm: "prompt",
  generic_agent: "prompt",
  post_ticket_comment: "body",
  post_pr_comment: "body",
} as const satisfies Partial<Record<WorkflowBlockType, string>>;

function validateStaticFallbackInputIssues(
  def: WorkflowDefinitionV1,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    const inputName = STATIC_FALLBACK_INPUTS[node.type as keyof typeof STATIC_FALLBACK_INPUTS];
    if (inputName === undefined) continue;
    const staticValue = node.params[inputName];
    const hasStaticValue = typeof staticValue === "string" && staticValue.trim().length > 0;
    const hasBinding = Object.prototype.hasOwnProperty.call(node.inputs, inputName);
    if (!hasStaticValue && !hasBinding) {
      issues.push(
        deploymentIssue(
          `Block "${node.id}" (${node.type}) requires either a non-empty "${inputName}" parameter or a compatible "${inputName}" input binding.`,
          node.id,
          `/nodes/${nodeIndex}/params/${inputName}`,
        ),
      );
    }
  }
  return issues;
}

const WORKSPACE_PRODUCERS = new Set<WorkflowBlockType>([
  "prepare_workspace",
  "implementation_agent",
  "review_agent",
  "fix_agent",
]);

function requiresWorkspaceProducer(node: WorkflowDefinitionV1Node): boolean {
  return (
    node.type === "run_checks" ||
    node.type === "run_pre_pr_checks" ||
    node.type === "finalize_workspace" ||
    (node.type === "generic_agent" && node.params.workspaceMode !== "none")
  );
}

function validateWorkspaceCapabilityIssues(
  def: WorkflowDefinitionV1,
  graphContext: WorkflowBindingGraphContext,
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, consumer] of def.nodes.entries()) {
    if (!requiresWorkspaceProducer(consumer)) continue;
    const dominators = graphContext.dominators.get(consumer.id);
    const hasGuaranteedProducer = def.nodes.some((producer) => {
      if (!WORKSPACE_PRODUCERS.has(producer.type) || !dominators?.has(producer.id)) return false;
      const pathsToConsumer = (graphContext.outgoing.get(producer.id) ?? []).filter(({ to }) =>
        graphContext.reachableFromNode.get(to)?.has(consumer.id),
      );
      return pathsToConsumer.length > 0 && pathsToConsumer.every(({ port }) => port !== FAILURE_PORT);
    });
    if (!hasGuaranteedProducer) {
      issues.push(
        deploymentIssue(
          `Block "${consumer.id}" (${consumer.type}) requires a workspace-producing block to run before it on every path.`,
          consumer.id,
          `/nodes/${nodeIndex}`,
        ),
      );
    }
  }
  return issues;
}

/**
 * Arbitrary-provider PR subjects have no trusted ticket or owned workspace.
 * They may materialize a checkout for review, but repository-owned commands
 * must never run in the credential-bearing agent sandbox.
 * This same function is called at runtime so definitions deployed before this
 * rule fail closed instead of gaining mutation privileges.
 */
export const ANY_SCOPE_BLOCK_POLICY = {
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
  branch: "safe",
  loop: "safe",
  terminate: "deny",
} as const satisfies Record<WorkflowBlockTypeV1, "entry" | "safe" | "deny">;

export function validateAnyScopeReviewSafety(def: WorkflowDefinitionV1): string[] {
  return validateAnyScopeReviewSafetyIssues(def).map(({ message }) => message);
}

export function validateAnyScopeReviewSafetyIssues(
  def: WorkflowDefinitionV1,
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
