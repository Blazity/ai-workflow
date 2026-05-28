export type RunStatus = "success" | "running" | "failed" | "blocked" | "awaiting";
export type SpanKind = "workflow" | "llm" | "tool" | "guardrail" | "retrieval";
export type SpanStatus = "ok" | "warn" | "error";

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
  tokens: number;
  cost: number;
  spans: number;
  evalScore: number;
  guardrailHits: number;
  // Decorated (Linear/Jira/GitHub refs)
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

export interface Span {
  id: string;
  parent: string | null;
  name: string;
  kind: SpanKind;
  start: number;
  duration: number;
  status: SpanStatus;
  attrs?: Record<string, string | number>;
  evals?: Record<string, number>;
}

export interface EvalMetric {
  metric: string;
  value: number;
  target: string;
  status: "pass" | "warn" | "fail";
  trend: number;
  axis: "safety" | "quality" | "ops";
  family: string;
  unit?: string;
}

export interface CostByModel {
  model: string;
  vendor: string;
  cost: number;
  tokens: number;
  share: number;
}

export interface HourPoint {
  h: number;
  runs: number;
  cost: number;
  p95: number;
  errors: number;
}

export interface Deployment {
  id: string;
  ref: string;
  actor: string;
  when: string;
  status: "ready" | "preview" | "error";
  workflow: string;
  env: string;
}

export interface Alert {
  id: string;
  severity: "warn" | "info" | "error";
  who: string;
  msg: string;
  when: string;
}

export type PromptTag = "production" | "staging" | "draft" | "archived" | "locked" | "ab-test";

export interface Prompt {
  id: string;
  name: string;
  workflow: string;
  workflowName: string;
  span: string;
  versionCount: number;
  current: string;
  trafficSplit: Record<string, number>;
  evalScore: number;
  evalDelta: number;
  lastEditedBy: string;
  lastEditedAtMin: number;
  tags: PromptTag[];
  model: string;
}

export interface PromptVersion {
  v: string;
  deployedAt: string;
  by: string;
  status: PromptTag;
  traffic: number;
  evalScore: number;
  runs: number;
  costAvg: number;
  p95: number;
  halluc: number;
  change: string;
}

export interface AIWFData {
  WORKFLOWS: Workflow[];
  RUNS: Run[];
  LIVE_RUNS: Run[];
  TRACE: Span[];
  EVALS: EvalMetric[];
  COST_BY_MODEL: CostByModel[];
  HOURS24: HourPoint[];
  DEPLOYMENTS: Deployment[];
  ALERTS: Alert[];
  PROMPTS: Prompt[];
  PROMPT_VERSIONS: Record<string, PromptVersion[]>;
  PROMPT_BODIES: Record<string, string>;
}
