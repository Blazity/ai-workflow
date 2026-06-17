import type { Run } from "@shared/contracts";

/**
 * Pick which run the ticket view shows on the right. Honors the `?run=` URL
 * param when it names a real run; otherwise defaults to the newest run (the
 * worker returns runs newest-first). Returns null only when the ticket has no
 * runs at all.
 */
export function pickSelectedRunId(
  runs: Run[],
  requested: string | null | undefined,
): string | null {
  if (runs.length === 0) return null;
  if (requested && runs.some((r) => r.id === requested)) return requested;
  return runs[0].id;
}
