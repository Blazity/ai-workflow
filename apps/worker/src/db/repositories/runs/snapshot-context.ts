import { and, desc, inArray, isNotNull } from "drizzle-orm";
import { getDb, type Db } from "../../client.js";
import { activeRunSandboxes, activeRuns, gateCurrent } from "../../schema.js";

export async function listSnapshotActiveRuns(db: Db, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .select({
      subjectKey: activeRuns.subjectKey,
      ownerToken: activeRuns.ownerToken,
      runId: activeRuns.runId,
      ticketKey: activeRuns.ticketKey,
    })
    .from(activeRuns)
    .where(and(isNotNull(activeRuns.runId), inArray(activeRuns.runId, runIds)));
}

export async function listSnapshotOwnerSandboxes(db: Db, subjectKeys: string[]) {
  if (subjectKeys.length === 0) return [];
  return db
    .select()
    .from(activeRunSandboxes)
    .where(inArray(activeRunSandboxes.subjectKey, subjectKeys))
    .orderBy(desc(activeRunSandboxes.createdAt));
}

export async function listSnapshotGateCurrent(db: Db, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .select({
      runId: gateCurrent.runId,
      repo: gateCurrent.repo,
      pr: gateCurrent.pr,
    })
    .from(gateCurrent)
    .where(inArray(gateCurrent.runId, runIds));
}

export function listConnectedSnapshotActiveRuns(runIds: string[]) {
  return listSnapshotActiveRuns(getDb(), runIds);
}

export function listConnectedSnapshotOwnerSandboxes(subjectKeys: string[]) {
  return listSnapshotOwnerSandboxes(getDb(), subjectKeys);
}

export function listConnectedSnapshotGateCurrent(runIds: string[]) {
  return listSnapshotGateCurrent(getDb(), runIds);
}
