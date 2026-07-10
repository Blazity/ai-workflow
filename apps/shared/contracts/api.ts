import type {
  PrePrCheckConfigVersion,
  PromptDef,
  RepositoryOption,
  Run,
  RunDetail,
  RunStep,
  Workflow,
  WorkflowDefinition,
  WorkflowDefinitionVersion,
  WorkflowEditorOptions,
} from "./domain.js";

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

export type EvalsResponse =
  | {
      available: true;
      generatedAt: string;
      windowHours: number;
      /** continuous_eval_success_rate × 100, fleet-wide. */
      score: number;
      /** Σ eval_count across tasks — "spans graded" in the window. */
      spansGraded: number;
      /** Σ trace_count across tasks. */
      traceCount: number;
    }
  | { available: false; generatedAt: string; reason: string };

export interface CostByWorkflowEntry {
  /** Arthur task_id (per ticket-run, e.g. "AWT-42" / "AWT-42.1"). */
  taskId: string;
  /** Arthur task name (= the ticket-run identifier). */
  name: string;
  /** trace_count for the task. */
  runs: number;
  /** trace_token_count. */
  tokens: number;
  /** trace_token_cost (USD). */
  cost: number;
  /** cost / max(1, runs). */
  costPerRun: number;
}

export interface CostResponse {
  generatedAt: string;
  /**
   * false when Arthur is unconfigured/unreachable or returns nothing. The
   * screen renders its empty/N-A state.
   */
  available: boolean;
  /** Window the figures cover (month-to-date). ISO. */
  window: { start: string; end: string };
  totals: {
    /** USD, Σ trace total_token_cost over the window. */
    totalTokenCost: number;
    /** Σ trace total_token_count over the window. */
    totalTokens: number;
    /** Number of traces in the window. */
    traceCount: number;
    /** totalTokenCost / max(1, traceCount). */
    costPerRun: number;
  };
  /** Per-task (= per ticket-run) breakdown, aggregated from the trace rows. */
  byWorkflow: CostByWorkflowEntry[];
  /** Per-day spend, oldest→newest, bucketed by trace start_time. */
  daily: { date: string; cost: number; tokens: number }[];
}

export interface PromptsResponse {
  generatedAt: string;
  /** `false` when the worker can't resolve prompts (degrades to empty list). */
  available: boolean;
  /**
   * Whether Arthur is configured (key + endpoint + task id all set). When
   * false, every prompt's `source` is "fallback" and `versions` is empty.
   */
  arthurEnabled: boolean;
  rows: PromptDef[];
  total: number;
}

/** On-demand body for a single historical Arthur version. */
export interface PromptVersionBodyResponse {
  generatedAt: string;
  available: boolean;
  body: string | null;
}

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

export interface TicketRunsResponse {
  generatedAt: string;
  available: boolean;
  ticket: { key: string; title: string; url: string } | null;
  runs: Run[];
  totals: {
    cost: number;
    tokens: number;
    runCount: number;
    counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
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

export interface PrePrChecksResponse {
  current: PrePrCheckConfigVersion | null;
  /** Newest first, capped at 50. */
  versions: PrePrCheckConfigVersion[];
}

export interface PrePrCheckSaveResponse {
  version: PrePrCheckConfigVersion;
}

export interface RepositoriesResponse {
  repositories: RepositoryOption[];
}

export interface WorkflowDefinitionResponse {
  current: WorkflowDefinitionVersion | null;
  versions: WorkflowDefinitionVersion[];
  defaultDefinition: WorkflowDefinition;
  options: WorkflowEditorOptions;
}

export interface WorkflowDefinitionSaveResponse {
  version: WorkflowDefinitionVersion;
}
