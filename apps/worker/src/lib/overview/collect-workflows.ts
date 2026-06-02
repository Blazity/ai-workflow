import { getWorkflowRegistry } from "./workflow-registry.js";
import type { WorkflowRow } from "@shared/contracts";

export interface CollectWorkflowsResult {
  rows: WorkflowRow[];
  total: number;
}

/**
 * Returns the entire static workflow registry as API rows. Metric fields are
 * `null` — historical aggregation is a separate workstream.
 */
export function collectWorkflows(): CollectWorkflowsResult {
  const registry = getWorkflowRegistry();
  const rows: WorkflowRow[] = registry.map((w) => ({
    id: w.id,
    name: w.name,
    blurb: w.blurb,
    gateway: w.gateway,
    primary: w.primary,
    runs24h: null,
    p50: null,
    p95: null,
    errRate: null,
    costToday: null,
    latestRun: null,
    trend24h: null,
  }));
  return { rows, total: rows.length };
}
