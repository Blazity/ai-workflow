import { getWorkflowRegistry } from "./workflow-registry.js";
import type { WorkflowRow } from "@shared/contracts";

export interface CollectWorkflowsResult {
  rows: WorkflowRow[];
  total: number;
}

/**
 * The static registry widened to `WorkflowRow` with `null` metric fields. Used
 * as the degraded view when the run store can't be reached (e.g. local dev
 * without the Vercel runtime) — the card still lists the workflows.
 */
export function registryRows(): CollectWorkflowsResult {
  const rows: WorkflowRow[] = getWorkflowRegistry().map((w) => ({
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
