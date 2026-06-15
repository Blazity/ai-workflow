import { inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { activeRuns, gateCurrent } from "../../db/schema.js";
import {
  STATUS_MAP,
  mapWorkflow,
  type RunsLister,
} from "../overview/collect-runs.js";
import type { RunSnapshot } from "./run-telemetry.js";

export interface CollectSnapshotsOptions {
  /** The Workflow world run store — `getWorld().runs`. */
  runsLister: RunsLister;
  db: Db;
  /** Max recent runs to snapshot per cycle. */
  limit?: number;
}

/**
 * Builds lifecycle snapshot rows from the Workflow world for the poll cron.
 * Deliberately makes NO external (Jira) calls: ticketKey + sandboxId come from
 * the run registry and gate PRs from gate_current, both already in Neon. Ticket
 * titles are filled by the agent workflow's own write, which has them for free.
 */
export async function collectSnapshots(
  opts: CollectSnapshotsOptions,
): Promise<RunSnapshot[]> {
  const { runsLister, db } = opts;
  const limit = opts.limit ?? 100;

  // resolveData: "none" mirrors collect-runs — avoids the expired-run schema
  // rejection that would throw away the whole page.
  const { data } = await runsLister.list({
    resolveData: "none",
    pagination: { limit },
  });
  if (data.length === 0) return [];

  const runIds = data.map((r) => r.runId);

  const active = await db
    .select({
      runId: activeRuns.runId,
      ticketKey: activeRuns.ticketKey,
      sandboxId: activeRuns.sandboxId,
    })
    .from(activeRuns)
    .where(inArray(activeRuns.runId, runIds));
  const activeByRun = new Map(active.map((a) => [a.runId, a]));

  const gates = await db
    .select({
      runId: gateCurrent.runId,
      repo: gateCurrent.repo,
      pr: gateCurrent.pr,
    })
    .from(gateCurrent)
    .where(inArray(gateCurrent.runId, runIds));
  const gateByRun = new Map(gates.map((g) => [g.runId, g]));

  return data.map((run): RunSnapshot => {
    const { id, name } = mapWorkflow(run.workflowName);
    const startedAt = run.startedAt ?? run.createdAt;
    const durationSec =
      run.completedAt != null
        ? Math.max(
            0,
            Math.round((run.completedAt.getTime() - startedAt.getTime()) / 1000),
          )
        : null;
    const a = activeByRun.get(run.runId);
    const g = gateByRun.get(run.runId);

    return {
      runId: run.runId,
      workflowId: id,
      workflowName: name,
      status: STATUS_MAP[run.status],
      ticketKey: a?.ticketKey ?? null,
      ticketTitle: null, // workflow-owned
      ticketUrl: null, // workflow-owned
      sandboxId: a?.sandboxId ?? null,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      durationSec,
      prRepo: g?.repo ?? null,
      prNumber: g?.pr ?? null,
    };
  });
}
