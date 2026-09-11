import type { Db } from "../../db/types.js";
import {
  listConnectedSnapshotActiveRuns,
  listConnectedSnapshotGateCurrent,
  listConnectedSnapshotOwnerSandboxes,
  listSnapshotActiveRuns,
  listSnapshotGateCurrent,
  listSnapshotOwnerSandboxes,
} from "../../db/repositories/runs.js";
import {
  STATUS_MAP,
  mapWorkflow,
  type RunsLister,
} from "../overview/collect-runs.js";
import type { RunSnapshot } from "../../db/repositories/runs/telemetry.js";

export interface CollectSnapshotsOptions {
  /** The Workflow world run store — `getWorld().runs`. */
  runsLister: RunsLister;
  db: Db;
  /** Max recent runs to snapshot per cycle. */
  limit?: number;
}

type SnapshotContext = {
  activeRuns(runIds: string[]): ReturnType<typeof listSnapshotActiveRuns>;
  gateCurrent(runIds: string[]): ReturnType<typeof listSnapshotGateCurrent>;
  ownerSandboxes(subjectKeys: string[]): ReturnType<typeof listSnapshotOwnerSandboxes>;
};

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
  return collectSnapshotsWithContext({ runsLister, limit: opts.limit }, {
    activeRuns: (runIds) => listSnapshotActiveRuns(db, runIds),
    gateCurrent: (runIds) => listSnapshotGateCurrent(db, runIds),
    ownerSandboxes: (subjectKeys) => listSnapshotOwnerSandboxes(db, subjectKeys),
  });
}

/** Connected production path: callers provide only the Workflow world reader. */
export function collectConnectedSnapshots(
  opts: Omit<CollectSnapshotsOptions, "db">,
): Promise<RunSnapshot[]> {
  return collectSnapshotsWithContext(opts, {
    activeRuns: listConnectedSnapshotActiveRuns,
    gateCurrent: listConnectedSnapshotGateCurrent,
    ownerSandboxes: listConnectedSnapshotOwnerSandboxes,
  });
}

async function collectSnapshotsWithContext(
  opts: Omit<CollectSnapshotsOptions, "db">,
  context: SnapshotContext,
): Promise<RunSnapshot[]> {
  const { runsLister } = opts;
  const limit = opts.limit ?? 100;

  // resolveData: "none" mirrors collect-runs — avoids the expired-run schema
  // rejection that would throw away the whole page.
  const { data } = await runsLister.list({
    resolveData: "none",
    pagination: { limit },
  });
  if (data.length === 0) return [];

  const runIds = data.map((r) => r.runId);

  const active = await context.activeRuns(runIds);
  const boundActive = active.filter(
    (row): row is typeof row & { runId: string } => row.runId !== null,
  );
  const activeByRun = new Map(boundActive.map((row) => [row.runId, row]));
  const subjectKeys = [...new Set(boundActive.map((row) => row.subjectKey))];
  const ownedSandboxes = subjectKeys.length === 0
    ? []
    : await context.ownerSandboxes(subjectKeys);
  const sandboxByOwner = new Map<string, string>();
  for (const sandbox of ownedSandboxes) {
    const key = `${sandbox.subjectKey}\0${sandbox.ownerToken}`;
    if (!sandboxByOwner.has(key)) sandboxByOwner.set(key, sandbox.sandboxId);
  }

  const gates = await context.gateCurrent(runIds);
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
      subjectKey: a?.subjectKey ?? null,
      workflowId: id,
      workflowName: name,
      status: STATUS_MAP[run.status],
      ticketKey: a?.ticketKey ?? null,
      ticketTitle: null, // workflow-owned
      ticketUrl: null, // workflow-owned
      sandboxId: a
        ? sandboxByOwner.get(`${a.subjectKey}\0${a.ownerToken}`) ?? null
        : null,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      durationSec,
      prRepo: g?.repo ?? null,
      prNumber: g?.pr ?? null,
    };
  });
}
