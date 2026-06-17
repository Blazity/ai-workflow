import type { Run, TicketRunsResponse } from "@shared/contracts";
import { mergeLiveRuns } from "./merge-live-runs";

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

/**
 * Fold in-flight runs (`running`/`awaiting`) for this ticket into the ticket
 * view. `listRunsForTicket` reads only the durable `workflow_runs` table, so a
 * run that is still in the registry — and not yet snapshotted by the poll cron
 * (which doesn't fire on every deployment) or finished — would otherwise be
 * invisible here, even though `/runs` shows it. Reuses the same store-authoritative
 * merge as the runs screen, then recomputes the rollup over the merged set.
 */
export function mergeTicketLiveRuns(
  data: TicketRunsResponse,
  liveForTicket: Run[],
): TicketRunsResponse {
  if (liveForTicket.length === 0) return data;
  const merged = mergeLiveRuns(
    {
      generatedAt: data.generatedAt,
      available: data.available,
      rows: data.runs,
      total: data.totals.runCount,
      counts: data.totals.counts,
    },
    { generatedAt: data.generatedAt, rows: liveForTicket },
  );
  return {
    ...data,
    runs: merged.rows,
    totals: {
      cost: merged.rows.reduce((s, r) => s + (r.cost ?? 0), 0),
      tokens: merged.rows.reduce((s, r) => s + (r.tokens ?? 0), 0),
      runCount: merged.rows.length,
      counts: merged.counts,
    },
  };
}
