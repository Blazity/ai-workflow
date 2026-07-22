import { parseStepName, parseWorkflowName } from "workflow/observability";
import type {
  RunDetail,
  RunError,
  RunStep,
  RunStatus,
  StepStatus,
} from "@shared/contracts";
import { EXECUTION_DIAGNOSTIC_PREFIX } from "@shared/contracts";

type WorkflowStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Subset of a `WorkflowRun` record (from `world.runs.get`) that we read. */
export interface WorkflowRunRecord {
  runId: string;
  status: WorkflowStatus;
  workflowName: string;
  deploymentId?: string;
  error?: string | RunError;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/** Subset of a `Step` record (from `world.steps.list`) that we read. */
export interface WorkflowStepRecord {
  stepId: string;
  stepName: string;
  status: WorkflowStatus;
  attempt: number;
  error?: RunError;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * The slice of `getWorld()` the detail collector depends on. The real object is
 * `getWorld()`; this narrow interface keeps the collector testable with a fake.
 */
export interface RunDetailSource {
  runs: {
    get(
      id: string,
      params: { resolveData: "none" },
    ): Promise<WorkflowRunRecord>;
  };
  steps: {
    list(params: {
      runId: string;
      resolveData: "none";
      pagination?: { limit?: number };
    }): Promise<{ data: WorkflowStepRecord[] }>;
  };
}

const STATUS_MAP: Record<WorkflowStatus, RunStatus> = {
  completed: "success",
  failed: "failed",
  running: "running",
  pending: "running",
  cancelled: "blocked",
};

const STEP_STATUS_MAP: Record<WorkflowStatus, StepStatus> = {
  completed: "completed",
  failed: "failed",
  running: "running",
  pending: "pending",
  cancelled: "cancelled",
};

const WORKFLOW_MAP: Record<string, { id: string; name: string }> = {
  agentWorkflow: { id: "wf_agent", name: "Agent" },
  postPrGateWorkflow: { id: "wf_post_pr_gate", name: "Post-PR gate" },
};

function mapWorkflow(workflowName: string): { id: string; name: string } {
  let fn = workflowName;
  try {
    fn = parseWorkflowName(workflowName)?.functionName ?? workflowName;
  } catch {
    // Unparseable name — fall back to the raw value.
  }
  return WORKFLOW_MAP[fn] ?? { id: `wf_${fn}`, name: fn };
}

function stepLabel(stepName: string): string {
  try {
    return parseStepName(stepName)?.functionName ?? stepName;
  } catch {
    return stepName;
  }
}

/** Normalize the run's `error` field (string or structured) into a RunError. */
function normalizeRunError(error: string | RunError | undefined): RunError | null {
  if (!error) return null;
  if (typeof error === "string") return { message: error };
  const diagnosticId = error.code?.startsWith(EXECUTION_DIAGNOSTIC_PREFIX)
    ? error.code
    : error.message.match(/Diagnostic ID: (AIW-DIAG-[A-Za-z0-9._:-]+)/)?.[1];
  if (diagnosticId) {
    return { message: error.message, code: diagnosticId };
  }
  return error;
}

export function sanitizeRunStepsForDiagnosticError(
  steps: RunStep[] | null,
  error: RunError | null,
): RunStep[] | null {
  if (!steps || !error?.code?.startsWith(EXECUTION_DIAGNOSTIC_PREFIX)) {
    return steps;
  }
  const safeError = { message: error.message, code: error.code };
  return steps.map((step) =>
    step.error ? { ...step, error: safeError } : step,
  );
}

export interface CollectRunDetailOptions {
  world: RunDetailSource;
  model: string;
  runId: string;
}

export interface CollectRunDetailResult {
  run: RunDetail;
  steps: RunStep[];
}

/**
 * Builds the single-run trace from the Vercel Workflow run store: the run
 * header (`runs.get`) plus its ordered step waterfall (`steps.list`). Both use
 * `resolveData: "none"` — the same lazy mode `collectRuns` relies on to avoid
 * the expired-run schema crash, and because step input/output is encrypted at
 * rest and not renderable here anyway.
 */
export async function collectRunDetail(
  opts: CollectRunDetailOptions,
): Promise<CollectRunDetailResult> {
  const { world, model, runId } = opts;

  // The steps endpoint caps `limit` at 100 (a higher value is rejected with
  // HTTP 400; the default page size is only 20). 100 comfortably covers the
  // agent/post-PR workflows, whose step counts are well under that.
  const [run, stepsPage] = await Promise.all([
    world.runs.get(runId, { resolveData: "none" }),
    world.steps.list({ runId, resolveData: "none", pagination: { limit: 100 } }),
  ]);

  const runStart = (run.startedAt ?? run.createdAt).getTime();
  const { id, name } = mapWorkflow(run.workflowName);
  const runError = normalizeRunError(run.error);

  const mappedSteps: RunStep[] = stepsPage.data
    .map((s): RunStep => {
      const start = (s.startedAt ?? s.createdAt).getTime();
      const durationMs =
        s.completedAt != null
          ? Math.max(0, s.completedAt.getTime() - start)
          : null;
      return {
        stepId: s.stepId,
        name: stepLabel(s.stepName),
        rawName: s.stepName,
        status: STEP_STATUS_MAP[s.status],
        attempt: s.attempt,
        createdAt: s.createdAt.toISOString(),
        startedAt: s.startedAt?.toISOString() ?? null,
        completedAt: s.completedAt?.toISOString() ?? null,
        startOffsetMs: Math.max(0, start - runStart),
        durationMs,
        error: s.error ?? null,
      };
    })
    .sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  const steps = sanitizeRunStepsForDiagnosticError(mappedSteps, runError) ?? [];

  const startedAt = run.startedAt ?? run.createdAt;
  const durationSec =
    run.completedAt != null
      ? Math.max(
          0,
          Math.round((run.completedAt.getTime() - startedAt.getTime()) / 1000),
        )
      : null;

  const detail: RunDetail = {
    id: run.runId,
    workflow: id,
    workflowName: name,
    status: STATUS_MAP[run.status],
    // The Workflow world has no ticket (encrypted input) or PR; the route
    // enriches all of these from the durable workflow_runs row.
    ticket: "",
    ticketTitle: "",
    ticketUrl: "",
    prNumber: null,
    prUrl: null,
    model,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    durationSec,
    error: runError,
    deploymentId: run.deploymentId ?? null,
  };

  return { run: detail, steps };
}

/**
 * Capture just the step waterfall for a run, reusing collectRunDetail so the
 * persisted shape is identical to the live read. Best-effort: returns null on
 * any world failure (expired run / world unavailable) so the caller — the
 * agent's telemetry step — never throws. The header is discarded, so the model
 * arg is irrelevant.
 */
export async function captureRunStepsBestEffort(
  world: RunDetailSource,
  runId: string,
): Promise<RunStep[] | null> {
  try {
    const { steps } = await collectRunDetail({ world, model: "", runId });
    return steps;
  } catch {
    return null;
  }
}
