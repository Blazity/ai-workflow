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
