import { parseWorkflowName } from "workflow/observability";
import type { RunStatus } from "@shared/contracts";

export interface RunsLister {
  list(params?: {
    resolveData?: "none" | "all";
    pagination?: { limit?: number; cursor?: string };
  }): Promise<{ data: WorkflowRunRecord[] }>;
}

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
    // Unparseable name: fall back to the raw value.
  }
  return WORKFLOW_MAP[fn] ?? { id: `wf_${fn}`, name: fn };
}
