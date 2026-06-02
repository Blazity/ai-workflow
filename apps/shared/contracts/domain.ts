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

export interface HourPoint {
  h: number;
  runs: number;
  cost: number;
  p95: number;
  errors: number;
}
