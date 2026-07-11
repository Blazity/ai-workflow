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
  | "planning_agent"
  | "implementation_agent"
  | "review_agent"
  | "run_pre_pr_checks"
  | "open_pr"
  | "update_ticket_status"
  | "send_slack_message"
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

export type WorkflowParamValue = string | number | boolean;

export interface WorkflowDefinitionNode {
  id: string;
  type: WorkflowBlockType;
  name?: string;
  x: number;
  y: number;
  params: Record<string, WorkflowParamValue>;
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

export interface WorkflowDefinitionVersion {
  version: number;
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
  blockStatuses: Record<string, BlockRunState>;
  updatedAt: string;
  completedAt: string | null;
}
