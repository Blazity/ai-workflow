import type {
  KpisResponse,
  EvalHealthResponse,
  EvalsResponse,
  CostResponse,
  PromptsResponse,
  RunsResponse,
  RunDetailResponse,
  LiveRunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";

export function kpisFallback(now: string): KpisResponse {
  return {
    generatedAt: now,
    runs24h: null,
    p95: null,
    errors24h: null,
    cost24h: null,
  };
}

export function evalHealthFallback(): EvalHealthResponse {
  return { available: false, reason: "Worker unavailable." };
}

export function recentRunsFallback(now: string): RunsResponse {
  return {
    generatedAt: now,
    available: false,
    rows: [],
    total: 0,
    counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
  };
}

export function runDetailFallback(now: string): RunDetailResponse {
  return { generatedAt: now, available: false, run: null, steps: [] };
}

export function liveRunsFallback(now: string): LiveRunsResponse {
  return { generatedAt: now, rows: [] };
}

export function workflowsFallback(now: string): WorkflowsResponse {
  return { generatedAt: now, rows: [], total: 0 };
}

export function evalsFallback(now: string): EvalsResponse {
  return { available: false, generatedAt: now, reason: "Worker unavailable." };
}

export function costFallback(now: string): CostResponse {
  return {
    generatedAt: now,
    available: false,
    window: { start: now, end: now },
    totals: { totalTokenCost: 0, totalTokens: 0, traceCount: 0, costPerRun: 0 },
    byModel: [],
    byWorkflow: [],
    daily: [],
  };
}

export function promptsFallback(now: string): PromptsResponse {
  return { generatedAt: now, available: false, arthurEnabled: false, rows: [], total: 0 };
}
