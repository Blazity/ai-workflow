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

/** One Arthur version of a named prompt (metadata; body fetched on demand). */
export interface PromptVersion {
  /** Arthur integer version number. */
  version: number;
  /** ISO timestamp the version was created. */
  createdAt: string;
  /** Real Arthur tags on this version, e.g. ["production"]. */
  tags: string[];
  modelProvider: string;
  modelName: string;
  numMessages: number;
  numTools: number;
  /** Body text. Present only for the production version (eager); other
   *  versions are fetched on demand via the by-version endpoint. */
  body?: string;
}

/** A workflow phase prompt as resolved by the worker at runtime. */
export interface PromptDef {
  /** Stable Arthur/fallback key: "research-plan" | "implement" | "review". */
  name: string;
  /** Human label for the workflow phase, e.g. "Research & Plan". */
  phase: string;
  /** Resolved production prompt body (Arthur production tag, or in-code fallback). */
  body: string;
  /** Where the resolved `body` came from. */
  source: "arthur" | "fallback";
  /** Model the agent runs this prompt with (env-derived). */
  model: string;
  /** Real Arthur version history, newest first. Empty when source is "fallback". */
  versions: PromptVersion[];
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

/** Any value expressible in JSON, used for block outputs and condition operands. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Structured result a block reports on completion. `status` is always present;
 *  the remaining keys are block-specific JSON the graph engine can read. */
export interface BlockOutput {
  status: string;
  [key: string]: JsonValue;
}

export type TicketStatusTarget = "ai_review" | "backlog";

export type WorkflowParamValue = string | number | boolean | string[];

/** Exact persisted source path for one block input. Syntax and graph safety are
 * validated by the worker; the template union keeps authored definitions on
 * the three supported roots without embedding graph semantics in this package. */
export type WorkflowBindingSource =
  | `trigger.${string}`
  | `steps.${string}.output.${string}`
  | `run.${string}`;

export type WorkflowInputBindings = Record<string, WorkflowBindingSource>;

/** Small JSON-shaped type language used by block input/output contracts. */
export type WorkflowValueSchema =
  | { type: "string" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "unknown" }
  | { type: "nullable"; value: WorkflowValueSchema }
  | { type: "array"; items: WorkflowValueSchema }
  | {
      type: "object";
      properties: Record<string, WorkflowValueSchema>;
      required: string[];
      additionalProperties: boolean;
    };

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
    /** Complete executor envelope, including failure and clarification output. */
    schema: WorkflowValueSchema;
    /** Fields guaranteed when execution continues through a normal output port. */
    bindingSchema: WorkflowValueSchema;
    statusVariants: string[];
  };
  availability: WorkflowBlockAvailability;
}

export interface WorkflowDefinitionNode {
  id: string;
  type: WorkflowBlockType;
  name?: string;
  x: number;
  y: number;
  params: Record<string, WorkflowParamValue>;
  inputs: WorkflowInputBindings;
}

export interface WorkflowDefinitionEdge {
  from: string;
  to: string;
  fromPort?: string;
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
}

/** Presentation-only node coordinates, persisted independently from a draft. */
export interface WorkflowDefinitionLayout {
  nodes: Record<string, { x: number; y: number }>;
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

export type WorkflowDefinitionDeploymentAction = "deploy" | "rollback" | "migration";

export interface WorkflowDefinitionDeployment {
  id: number;
  definitionId: number;
  selectedVersion: number;
  previousVersion: number | null;
  action: WorkflowDefinitionDeploymentAction;
  rollbackFromVersion: number | null;
  createdAt: string;
  createdById: string;
  createdByLabel: string;
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
  ticketKey: string;
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
  /** Resume run started on answer; null until dispatched. */
  dispatchedRunId: string | null;
}
