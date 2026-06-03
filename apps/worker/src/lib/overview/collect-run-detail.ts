import { parseStepName, parseWorkflowName } from "workflow/observability";
import type {
  RunDetail,
  RunError,
  RunStep,
  RunStatus,
  StepStatus,
} from "@shared/contracts";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import { runLabel } from "../labels.js";

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
  return error;
}

export interface CollectRunDetailOptions {
  world: RunDetailSource;
  issueTracker: IssueTrackerAdapter;
  jiraBaseUrl: string;
  /** Jira project key, used to scope the run-label lookup query. */
  projectKey: string;
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
  const { world, issueTracker, jiraBaseUrl, model, runId } = opts;
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  // The steps endpoint caps `limit` at 100 (a higher value is rejected with
  // HTTP 400; the default page size is only 20). 100 comfortably covers the
  // agent/post-PR workflows, whose step counts are well under that.
  const [run, stepsPage] = await Promise.all([
    world.runs.get(runId, { resolveData: "none" }),
    world.steps.list({ runId, resolveData: "none", pagination: { limit: 100 } }),
  ]);

  const runStart = (run.startedAt ?? run.createdAt).getTime();
  const { id, name } = mapWorkflow(run.workflowName);

  const steps: RunStep[] = stepsPage.data
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

  const { ticket, ticketTitle } = await resolveRunTicket(
    runId,
    issueTracker,
    opts.projectKey,
  );

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
    ticket,
    ticketTitle,
    ticketUrl: ticket ? `${tenantOrigin}/browse/${ticket}` : "",
    model,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    durationSec,
    error: normalizeRunError(run.error),
    deploymentId: run.deploymentId ?? null,
  };

  return { run: detail, steps };
}

/**
 * Best-effort ticket key + title for a run. The dispatcher tags each ticket
 * with a `run:<id>` label, so one JQL search recovers the ticket even though
 * the workflow's serialized `input` is encrypted. Any failure yields empty
 * strings and the trace header degrades to the run id alone.
 */
async function resolveRunTicket(
  runId: string,
  issueTracker: IssueTrackerAdapter,
  projectKey: string,
): Promise<{ ticket: string; ticketTitle: string }> {
  const jql = `project = "${projectKey}" AND labels in ("${runLabel(runId)}")`;
  try {
    const keys = (await issueTracker.searchTickets(jql)) ?? [];
    const key = keys[0];
    if (!key) return { ticket: "", ticketTitle: "" };
    const t = await issueTracker.fetchTicket(key);
    return { ticket: key, ticketTitle: t.title || key };
  } catch {
    return { ticket: "", ticketTitle: "" };
  }
}
