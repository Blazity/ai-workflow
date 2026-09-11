import type { BlockRunState } from "@shared/contracts";

export type RunBlockStatusSummary = Omit<BlockRunState, "output">;

/**
 * Block output can contain large or secret-bearing provider payloads. The
 * workflow owns the dashboard-facing summary, while telemetry persists the
 * already-sanitized state as an opaque value.
 */
export function summarizeRunBlockStatuses(
  blockStatuses: Record<string, BlockRunState>,
): Record<string, RunBlockStatusSummary> {
  return Object.fromEntries(
    Object.entries(blockStatuses).map(([nodeId, state]) => {
      const { output: _output, ...summary } = state;
      return [nodeId, summary];
    }),
  );
}
