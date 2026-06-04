import type { Run, RunDetail, RunStep, Workflow } from "./domain.js";

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

export interface KpisResponse {
  generatedAt: string;
  runs24h: { value: number; deltaPct: number; spark: number[] } | null;
  p95: { valueSec: number; deltaSec: number; spark: number[] } | null;
  errors24h: { value: number; deltaPct: number; spark: number[] } | null;
  cost24h: { value: number; deltaPct: number } | null;
}

export type EvalHealthResponse =
  | {
      available: true;
      score: number;
      pass: number;
      warn: number;
      fail: number;
      spansGraded: number;
      windowHours: number;
    }
  | { available: false; reason: string };

export interface LiveRunsResponse {
  generatedAt: string;
  rows: Run[];
}

export interface RunsResponse {
  generatedAt: string;
  available: boolean;
  rows: Run[];
  total: number;
  counts: {
    success: number;
    running: number;
    awaiting: number;
    failed: number;
    blocked: number;
  };
}

export interface RunDetailResponse {
  generatedAt: string;
  /** `false` when the run can't be read (worker/world unavailable or unknown id). */
  available: boolean;
  run: RunDetail | null;
  steps: RunStep[];
}

export interface WorkflowRow extends Pick<Workflow, "id" | "name" | "blurb" | "gateway"> {
  primary?: boolean;
  runs24h: number | null;
  p50: number | null;
  p95: number | null;
  errRate: number | null;
  costToday: number | null;
  latestRun: Pick<
    Run,
    "ticket" | "ticketUrl" | "ticketTitle" | "prNumber" | "prUrl"
  > | null;
  trend24h: number[] | null;
}

export interface WorkflowsResponse {
  generatedAt: string;
  rows: WorkflowRow[];
  total: number;
}
