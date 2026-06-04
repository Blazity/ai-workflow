import type { SpanKind, Workflow, Run, HourPoint } from "@shared/contracts";

export type {
  RunStatus,
  SpanKind,
  Workflow,
  Run,
  HourPoint,
} from "@shared/contracts";

export type SpanStatus = "ok" | "warn" | "error";

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
