import type { RunDetail, RunStep } from "@shared/contracts";

export interface RunDetailParts {
  run: RunDetail;
  steps: RunStep[];
  hasRealSteps: boolean;
}

/**
 * Pick the trace source. Persisted real steps (a finished run) win and skip the
 * world entirely — this is the "one place" read. Otherwise load the live world
 * waterfall (an in-flight run); if that fails (run aged out of the ~24h window,
 * or world unavailable) fall back to the coarse db detail, or null if there is
 * no row at all.
 */
export async function resolveRunDetail(opts: {
  dbDetail: RunDetailParts | null;
  loadWorld: () => Promise<{ run: RunDetail; steps: RunStep[] }>;
}): Promise<{ run: RunDetail; steps: RunStep[] } | null> {
  const { dbDetail, loadWorld } = opts;
  if (dbDetail?.hasRealSteps) {
    return { run: dbDetail.run, steps: dbDetail.steps };
  }
  try {
    const world = await loadWorld();
    // The world knows nothing about the catalog, so the repository list the run
    // froze at start can only come from the durable row. Carried here because
    // the world wins for exactly the in-flight runs somebody is watching: drop
    // it and the header would show no access line while the run is live and
    // grow one when it lands, which reads as the list having changed.
    const run: RunDetail = {
      ...world.run,
      repositoryAccess:
        world.run.repositoryAccess ?? dbDetail?.run.repositoryAccess ?? null,
    };
    // A run parked on a clarification is suspended on a workflow hook, which the
    // world still reports as "running". Only the durable row knows it is waiting
    // for an answer, so it overrides that one world status. A world run that
    // already settled (success/failed/blocked) always wins, so a stale
    // "awaiting" row can never resurrect an answer form on a dead run.
    if (dbDetail?.run.status === "awaiting" && world.run.status === "running") {
      return { run: { ...run, status: "awaiting" }, steps: world.steps };
    }
    return { run, steps: world.steps };
  } catch {
    return dbDetail ? { run: dbDetail.run, steps: dbDetail.steps } : null;
  }
}
