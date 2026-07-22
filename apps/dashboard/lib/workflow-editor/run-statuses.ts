import type { RunBlockStatusSnapshot } from "@shared/contracts";
import type { RunStatusMap } from "@/lib/flows";

export interface DerivedRunStatuses {
  statuses: RunStatusMap;
  errors: Record<string, string>;
}

export function deriveRunStatuses(
  run: RunBlockStatusSnapshot | null,
  editor: { definitionId: number; version: number | null },
): DerivedRunStatuses | undefined {
  if (run === null) return undefined;
  if (run.definitionId !== editor.definitionId) return undefined;
  if (run.definitionVersion !== editor.version) return undefined;
  const statuses: RunStatusMap = {};
  const errors: Record<string, string> = {};
  for (const [nodeId, state] of Object.entries(run.blockStatuses)) {
    statuses[nodeId] = state.status;
    if (state.error !== undefined) {
      errors[nodeId] = state.diagnosticId
        ? `${state.error} Diagnostic ID: ${state.diagnosticId}`
        : state.error;
    }
  }
  return { statuses, errors };
}
