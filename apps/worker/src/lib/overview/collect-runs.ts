import { parseWorkflowName } from "workflow/observability";
import type { RunStatus } from "@shared/contracts";

/**
 * The slice of the Workflow DevKit's `world.runs` API we depend on. The real
 * object is `getWorld().runs`; this narrow interface keeps the collector
 * testable with a fake.
 */
export interface RunsLister {
  list(params?: {
    resolveData?: "none" | "all";
    pagination?: { limit?: number; cursor?: string };
  }): Promise<{ data: WorkflowRunRecord[] }>;
}

/** Subset of a `WorkflowRun` record (from `world.runs.list`) that we read. */
export interface WorkflowRunRecord {
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  workflowName: string;
  input?: unknown;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export const STATUS_MAP: Record<WorkflowRunRecord["status"], RunStatus> = {
  completed: "success",
  failed: "failed",
  running: "running",
  pending: "running",
  cancelled: "blocked",
};

const WORKFLOW_MAP: Record<string, { id: string; name: string }> = {
  agentWorkflow: { id: "wf_agent", name: "Agent" },
  postPrGateWorkflow: { id: "wf_post_pr_gate", name: "Post-PR gate" },
};

export function mapWorkflow(workflowName: string): { id: string; name: string } {
  let fn = workflowName;
  try {
    fn = parseWorkflowName(workflowName)?.functionName ?? workflowName;
  } catch {
    // Unparseable name — fall back to the raw value.
  }
  return WORKFLOW_MAP[fn] ?? { id: `wf_${fn}`, name: fn };
}
