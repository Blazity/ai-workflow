export type RunStatus = "success" | "running" | "failed" | "blocked" | "awaiting";
export type SpanKind = "workflow" | "llm" | "tool" | "guardrail" | "retrieval";

export interface Workflow {
  id: string;
  name: string;
  blurb: string;
  runs24h: number;
  p50: number;
  p95: number;
  errRate: number;
  costToday: number;
  gateway: string;
  primary?: boolean;
}

/**
 * Static identity of a workflow — the fields the worker actually knows without
 * any metric aggregation. The per-workflow registry returns this; the API layer
 * widens it to `WorkflowRow` by attaching `null` metric fields until historical
 * aggregation is wired up.
 */
export type WorkflowMeta = Pick<
  Workflow,
  "id" | "name" | "blurb" | "gateway" | "primary"
>;

export interface Run {
  id: string;
  workflow: string;
  workflowName: string;
  status: RunStatus;
  ticket: string;
  actor: string;
  model: string;
  startedAtMin: number;
  duration: number | null;
  // Aggregate/graded metrics — `null` means "not tracked yet", distinct from a
  // genuine 0. Renderers must branch on `=== null`, never truthiness.
  tokens: number | null;
  cost: number | null;
  spans: number | null;
  evalScore: number | null;
  guardrailHits: number | null;
  ticketTitle: string;
  prNumber: number | null;
  ticketUrl: string;
  prUrl: string | null;
  // Live — status === "running"
  currentSpan?: string;
  currentSpanKind?: SpanKind;
  progress?: number;
  spanIndex?: number;
  spansTotal?: number;
  elapsed?: number;
  etaSec?: number;
  // Human-in-the-loop — status === "awaiting"
  pausedAtSpan?: string;
  askedAtMin?: number;
  question?: string;
  questionFor?: string;
  blockingReason?: string;
  suggestedAnswers?: string[];
}

/** Structured error as returned by the Workflow runtime for failed runs/steps. */
export const EXECUTION_DIAGNOSTIC_PREFIX = "AIW-DIAG-";

export interface RunError {
  message: string;
  stack?: string;
  code?: string;
}

/** Lifecycle status of a single workflow step (mirrors the runtime enum). */
export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * One durable step execution from `world.steps.list({ runId })`. This is the
 * real data behind the run-trace timeline. Steps are flat (no parent/child),
 * so the trace renders as a waterfall ordered by `startOffsetMs`. A retried
 * step reports `attempt > 1`. Step input/output exist in the runtime but are
 * encrypted at rest and not decodable here, so they are intentionally omitted.
 */
export interface RunStep {
  stepId: string;
  /** Human-readable function name parsed from the raw step name. */
  name: string;
  /** The unparsed runtime step name (kept for debugging/uniqueness). */
  rawName: string;
  status: StepStatus;
  /** Retry attempt count (1 = first try). */
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Milliseconds from the run's start to this step's start. */
  startOffsetMs: number;
  /** Wall-clock duration; `null` while the step is still running/pending. */
  durationMs: number | null;
  error: RunError | null;
}

/**
 * Single-run header for the trace screen. Aggregate metrics (tokens, cost,
 * eval score) are deliberately absent — the Workflow runtime does not persist
 * them per run, so the trace screen does not pretend to show them.
 */
export interface RunDetail {
  id: string;
  workflow: string;
  workflowName: string;
  status: RunStatus;
  ticket: string;
  ticketTitle: string;
  ticketUrl: string;
  prNumber: number | null;
  prUrl: string | null;
  model: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSec: number | null;
  error: RunError | null;
  deploymentId: string | null;
}

export interface HourPoint {
  h: number;
  runs: number;
  cost: number;
  p95: number;
  errors: number;
}

// --- Pre-PR checks (dashboard-managed gate config) ---

export type VcsProviderKind = "github" | "gitlab";

export interface PrePrCheckRepositoryConfig {
  provider: VcsProviderKind;
  repoPath: string;
  commands: string[];
}

export interface PrePrCheckConfig {
  repositories: PrePrCheckRepositoryConfig[];
}

export interface PrePrCheckConfigVersion {
  version: number;
  config: PrePrCheckConfig;
  /** ISO timestamp. */
  createdAt: string;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

export interface RepositoryOption {
  provider: VcsProviderKind;
  repoPath: string;
  name: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
}

// --- Workflow definition (dashboard-managed run graph) ---

export type WorkflowBlockType =
  | "trigger_ticket_ai"
  | "trigger_plan_approved"
  | "trigger_pr_created"
  | "trigger_pr_checks_failed"
  | "trigger_pr_review"
  | "trigger_pr_merged"
  | "planning_agent"
  | "implementation_agent"
  | "review_agent"
  | "fix_agent"
  | "generic_agent"
  | "prepare_workspace"
  | "finalize_workspace"
  | "run_pre_pr_checks"
  | "run_checks"
  | "call_llm"
  | "transform"
  | "fetch_pr_context"
  | "open_pr"
  | "update_ticket_status"
  | "post_ticket_comment"
  | "post_pr_comment"
  | "send_slack_message"
  | "send_plan_approval"
  | "human_question"
  | "arthur_injection_check"
  | "branch"
  | "loop"
  | "terminate";

/** Block types executable by the legacy definition/interpreter. */
export type WorkflowBlockTypeV1 = Exclude<WorkflowBlockType, "transform">;

/** Any value expressible in JSON, used for block outputs and condition operands. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON Schema 2020-12 document persisted by structured-output blocks. */
export type JsonSchema202012 = { [key: string]: JsonValue };

/** Structured result a block reports on completion. `status` is always present;
 *  the remaining keys are block-specific JSON the graph engine can read. */
export interface BlockOutput {
  status: string;
  [key: string]: JsonValue;
}

/** Provider status identifier persisted by Update Ticket Status. Legacy
 * `ai_review` / `backlog` values remain valid for existing definitions. */
export type TicketStatusTarget = string;

export type WorkflowParamValue = string | number | boolean | string[];

/** Provenance of a prompt param copied from the prompt library. Purely
 *  informational: the runtime never reads it; the editor uses it to render
 *  "from library: Name vN" and to detect drift against the library head. */
export interface PromptSourceRef {
  /** prompt_library.id the text was copied from. */
  promptId: number;
  /** prompt_library_versions.version whose body was copied. */
  version: number;
  /** fnv1a hex of the inserted text, set by the editor at insert time so a
   *  later manual edit of the field can be detected as "edited". */
  insertedHash?: string;
}

/** Exact persisted source path for one block input. Syntax and graph safety are
 * validated by the worker; the template union keeps authored definitions on
 * the three supported roots without embedding graph semantics in this package. */
export type WorkflowBindingSource =
  | `trigger.${string}`
  | `steps.${string}.output.${string}`
  | `run.${string}`;

export type WorkflowInputBindings = Record<string, WorkflowBindingSource>;

export interface WorkflowValueSchemaMetadata {
  description?: string;
  enum?: JsonValue[];
}

/** Small JSON-shaped type language used by block input/output contracts. */
export type WorkflowValueSchema =
  | ({ type: "string" } & WorkflowValueSchemaMetadata)
  | ({ type: "number" } & WorkflowValueSchemaMetadata)
  | ({ type: "boolean" } & WorkflowValueSchemaMetadata)
  | ({ type: "null" } & WorkflowValueSchemaMetadata)
  | ({ type: "unknown" } & WorkflowValueSchemaMetadata)
  | ({ type: "nullable"; value: WorkflowValueSchema } & WorkflowValueSchemaMetadata)
  | ({ type: "array"; items: WorkflowValueSchema } & WorkflowValueSchemaMetadata)
  | ({
      type: "object";
      properties: Record<string, WorkflowValueSchema>;
      required: string[];
      additionalProperties: boolean;
    } & WorkflowValueSchemaMetadata);

export type WorkflowBlockGroup =
  | "trigger"
  | "agents"
  | "workspace"
  | "control"
  | "ticket"
  | "vcs"
  | "human"
  | "utility"
  | "arthur";

export interface WorkflowBlockPresentation {
  label: string;
  description: string;
  group: WorkflowBlockGroup;
  color: string;
  softColor: string;
  glyph: string;
}

export interface WorkflowBlockInputContract {
  required: boolean;
  schema: WorkflowValueSchema;
}

/** A safe, registry-owned family of additional named inputs. The worker still
 * validates every concrete input name against `keyPattern`; this is only the
 * serializable contract the editor uses to offer those inputs. */
export interface WorkflowBlockAdditionalInputContract {
  keyPattern: string;
  schema: WorkflowValueSchema;
}

export type WorkflowBlockAvailability =
  | { available: true; unavailableReason: null }
  | { available: false; unavailableReason: string };

/** Serializable contract returned by the worker-owned block registry. */
export interface WorkflowBlockContract {
  type: WorkflowBlockType;
  presentation: WorkflowBlockPresentation;
  defaults: Record<string, WorkflowParamValue>;
  ports: string[];
  allowsFailurePort: boolean;
  inputs: Record<string, WorkflowBlockInputContract>;
  additionalInputs: WorkflowBlockAdditionalInputContract[];
  output: {
    /** Complete domain-output envelope, including clarification outcomes. */
    schema: WorkflowValueSchema;
    /** Fields guaranteed when execution continues through a normal output port. */
    bindingSchema: WorkflowValueSchema;
    statusVariants: string[];
  };
  availability: WorkflowBlockAvailability;
}

export interface WorkflowDefinitionV1Node {
  id: string;
  type: WorkflowBlockTypeV1;
  name?: string;
  x: number;
  y: number;
  params: Record<string, WorkflowParamValue>;
  /** Keyed by the param key the text was inserted into (e.g. "prompt",
   *  "system", "body", "instructions", "message"). */
  promptRefs?: Record<string, PromptSourceRef>;
  inputs: WorkflowInputBindings;
}

export interface WorkflowDefinitionV1Edge {
  from: string;
  to: string;
  fromPort?: string;
}

/** Compatibility aliases for the v1 editor and interpreter. New version-aware
 * code should use the explicitly versioned names below. */
export type WorkflowDefinitionNode = WorkflowDefinitionV1Node;
export type WorkflowDefinitionEdge = WorkflowDefinitionV1Edge;

/** Canonical data paths persisted by v2 bindings. `entry` is the virtual
 * active-trigger source and is therefore reserved as a real node id. */
export type WorkflowDataReferenceV2 =
  | "steps.entry.output"
  | `steps.entry.output.${string}`
  | `steps.${string}.output`
  | `steps.${string}.output.${string}`
  | `run.${string}`;

export type WorkflowInputBindingV2 =
  | { kind: "reference"; reference: WorkflowDataReferenceV2 }
  | { kind: "literal"; value: JsonValue };

export interface WorkflowBranchLiteralOperandV2 {
  kind: "lit";
  value: string | number | boolean | null;
}

export interface WorkflowBranchPathOperandV2 {
  kind: "path";
  reference: WorkflowDataReferenceV2;
}

export type WorkflowBranchOperandV2 =
  | WorkflowBranchLiteralOperandV2
  | WorkflowBranchPathOperandV2;

/** Typed Boolean expression authored by v2 Branch blocks. */
export type WorkflowBranchBooleanAstV2 =
  | { kind: "lit"; value: boolean }
  | WorkflowBranchPathOperandV2
  | { kind: "not"; operand: WorkflowBranchBooleanAstV2 }
  | {
      kind: "and" | "or";
      left: WorkflowBranchBooleanAstV2;
      right: WorkflowBranchBooleanAstV2;
    }
  | {
      kind: "eq" | "neq";
      left: WorkflowBranchOperandV2;
      right: WorkflowBranchOperandV2;
    };

export interface WorkflowBranchConfigurationV2 {
  condition: WorkflowBranchBooleanAstV2;
}

/** Ordered, author-defined input exposed alongside a block's fixed inputs. */
export interface WorkflowAdditionalInputV2 {
  name: string;
  schema: JsonSchema202012;
  binding: WorkflowInputBindingV2;
}

export interface TransformInputPath {
  input: string;
  path: string[];
}

export type TransformMapValue =
  | {
      kind: "input";
      source: TransformInputPath;
      /** Used only when the source path is absent. An explicit null is kept. */
      defaultValue?: JsonValue;
    }
  | { kind: "literal"; value: JsonValue };

export interface TransformMapField {
  name: string;
  value: TransformMapValue;
}

export type TransformComparisonOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal";

export type TransformPredicate =
  | {
      kind: "comparison";
      /** Path within the current array item. Empty means the item itself. */
      path: string[];
      operator: TransformComparisonOperator;
      value: JsonValue;
    }
  | {
      kind: "is_null";
      /** Path within the current array item. Empty means the item itself. */
      path: string[];
      /** Absent paths do not count as null. */
      isNull: boolean;
    }
  | { kind: "all"; predicates: TransformPredicate[] }
  | { kind: "any"; predicates: TransformPredicate[] }
  | { kind: "not"; predicate: TransformPredicate };

export type TransformConfiguration =
  | { operation: "map_object"; fields: TransformMapField[] }
  | {
      operation: "filter_array";
      source: TransformInputPath;
      predicate: TransformPredicate;
    };

export interface WorkflowDefinitionV2Node {
  id: string;
  type: WorkflowBlockType;
  name?: string;
  x: number;
  y: number;
  configuration: Record<string, JsonValue>;
  inputs: Record<string, WorkflowInputBindingV2>;
  additionalInputs: WorkflowAdditionalInputV2[];
}

export interface WorkflowDefinitionV2ControlEdge {
  id: string;
  from: string;
  to: string;
  fromPort?: string;
}

export interface WorkflowExecutionBudgets {
  maxDurationMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

/** Structured terminal cause persisted when a workflow run stops on a budget. */
export type WorkflowRunBudgetFailure =
  | {
      status: "budget_exceeded";
      metric: "duration" | "tokens" | "cost";
      limit: number;
      consumed: number;
      reason: string;
    }
  | {
      status: "budget_unverifiable";
      metric: "tokens" | "cost";
      limit: number;
      consumed: null;
      reason: string;
    };

export interface WorkflowDefinitionV1 {
  schemaVersion: 1;
  budgets?: WorkflowExecutionBudgets;
  nodes: WorkflowDefinitionV1Node[];
  edges: WorkflowDefinitionV1Edge[];
}

export interface WorkflowDefinitionV2 {
  schemaVersion: 2;
  budgets?: WorkflowExecutionBudgets;
  nodes: WorkflowDefinitionV2Node[];
  edges: WorkflowDefinitionV2ControlEdge[];
}

export type WorkflowDefinition = WorkflowDefinitionV1 | WorkflowDefinitionV2;

export interface WorkflowLayoutPoint {
  x: number;
  y: number;
}

/** A missing edge entry means the editor should use automatic routing. */
export interface WorkflowEdgeGeometry {
  bend: WorkflowLayoutPoint;
}

/** Presentation-only geometry, persisted independently from a draft. */
export interface WorkflowDefinitionLayout {
  nodes: Record<string, WorkflowLayoutPoint>;
  edges: Record<string, WorkflowEdgeGeometry>;
}

/** Read compatibility for layouts persisted before edge routing existed. */
export interface WorkflowDefinitionLayoutInput {
  nodes: Record<string, WorkflowLayoutPoint>;
  edges?: Record<string, WorkflowEdgeGeometry>;
}

export interface WorkflowDefinitionVersion {
  version: number;
  definitionId: number;
  definition: WorkflowDefinition;
  createdAt: string;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

export interface WorkflowEditorOptions {
  agentKind: "claude" | "codex";
  defaultModel: string;
  defaultModels: { claude: string; codex: string };
  models: { claude: string[]; codex: string[] };
  ticketStatusTargets: { value: TicketStatusTarget; label: string }[];
  blockRegistry: Record<WorkflowBlockType, WorkflowBlockContract>;
  runBindingSchema: WorkflowValueSchema;
}

export type BlockRunStatus = "pending" | "running" | "ok" | "warn" | "fail";

export interface BlockRunState {
  status: BlockRunStatus;
  error?: string;
  /** Stable, user-safe correlation key for an execution error. */
  diagnosticId?: string;
  attempt?: number;
  output?: BlockOutput;
}

export interface RunBlockStatusSnapshot {
  runId: string;
  ticketKey: string | null;
  source: "live" | "last";
  status: RunStatus;
  definitionVersion: number | null;
  definitionId: number | null;
  blockStatuses: Record<string, BlockRunState>;
  updatedAt: string;
  completedAt: string | null;
}

// --- Plan-approval queue (human-in-the-loop) ---

export type ApprovalStatus = "pending" | "approved" | "rejected" | "superseded";

/** One plan awaiting (or past) a human decision, as exposed to the dashboard. */
export interface ApprovalRequest {
  id: string;
  ticketKey: string;
  definitionId: number;
  /** Head version of the definition when the plan was filed; the version the
   *  approval is pinned to. Null only for rows predating version pinning. */
  definitionVersion: number | null;
  /** Run that produced the plan. */
  runId: string;
  plan: { markdown: string };
  assumptions: string[] | null;
  status: ApprovalStatus;
  /** ISO timestamp. */
  requestedAt: string;
  requestedBy: string;
  decidedById: string | null;
  decidedByLabel: string | null;
  /** ISO timestamp; null while pending. */
  decidedAt: string | null;
  /** Run started on approval; null until dispatched. */
  dispatchedRunId: string | null;
}

// --- Clarification queue (human-in-the-loop input) ---

export type ClarificationStatus = "pending" | "answered" | "superseded";

/** One set of questions a run parked on awaiting a human answer, as exposed to
 *  the dashboard. */
export interface ClarificationRequest {
  id: string;
  ticketKey: string | null;
  /** Run that asked the questions. */
  runId: string;
  /** Graph node that raised the questions; null for the built-in default graph. */
  blockId: string | null;
  /** Definition the asking run belonged to; null for the built-in default. */
  definitionId: number | null;
  /** Head version of that definition when the questions were filed. */
  definitionVersion: number | null;
  questions: string[];
  suggestedAnswers: string[] | null;
  status: ClarificationStatus;
  /** ISO timestamp. */
  askedAt: string;
  answer: string | null;
  answeredById: string | null;
  answeredByLabel: string | null;
  /** ISO timestamp; null while pending. */
  answeredAt: string | null;
  /** Deprecated: clarification answers now resume the asking run in place. */
  dispatchedRunId: string | null;
}
