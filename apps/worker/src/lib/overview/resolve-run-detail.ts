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
    return await loadWorld();
  } catch {
    return dbDetail ? { run: dbDetail.run, steps: dbDetail.steps } : null;
  }
}
