import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { getDb, type Db } from "../../client.js";
import { approvalRequests, clarificationRequests, workflowRuns } from "../../schema.js";

export function listAwaitingRunRows(db: Db = getDb()) {
  return db.select({
    runId: workflowRuns.runId,
    workflowId: workflowRuns.workflowId,
    workflowName: workflowRuns.workflowName,
    ticketKey: workflowRuns.ticketKey,
    ticketTitle: workflowRuns.ticketTitle,
    ticketUrl: workflowRuns.ticketUrl,
    model: workflowRuns.model,
    harnessManifests: workflowRuns.harnessManifests,
    blockStatuses: workflowRuns.blockStatuses,
    startedAt: workflowRuns.startedAt,
    firstSeenAt: workflowRuns.firstSeenAt,
    prNumber: workflowRuns.prNumber,
    prUrl: workflowRuns.prUrl,
    prs: workflowRuns.prs,
    questions: clarificationRequests.questions,
    suggestedAnswers: clarificationRequests.suggestedAnswers,
    askedAt: clarificationRequests.askedAt,
    approvalId: approvalRequests.id,
  }).from(workflowRuns).leftJoin(clarificationRequests, and(
    eq(clarificationRequests.runId, workflowRuns.runId),
    eq(clarificationRequests.status, "pending"),
  )).leftJoin(approvalRequests, and(
    eq(approvalRequests.runId, workflowRuns.runId),
    eq(approvalRequests.status, "pending"),
  )).where(eq(workflowRuns.status, "awaiting")).orderBy(desc(
    sql`coalesce(${clarificationRequests.askedAt}, ${workflowRuns.startedAt}, ${workflowRuns.firstSeenAt})`,
  ));
}

export function findLiveBlockStatusRow(db: Db = getDb(), input: {
  runIds: string[];
  definitionId?: number;
}) {
  if (input.runIds.length === 0) return Promise.resolve();
  const definition = input.definitionId === undefined
    ? []
    : [eq(workflowRuns.definitionId, input.definitionId)];
  return db.select().from(workflowRuns).where(and(
    inArray(workflowRuns.runId, input.runIds),
    isNotNull(workflowRuns.blockStatuses),
    or(isNull(workflowRuns.status), notInArray(workflowRuns.status, ["success", "failed", "blocked"])),
    ...definition,
  )).orderBy(desc(workflowRuns.updatedAt)).limit(1).then(([row]) => row);
}

export function findLastBlockStatusRow(db: Db = getDb(), definitionId?: number) {
  const definition = definitionId === undefined
    ? []
    : [eq(workflowRuns.definitionId, definitionId)];
  return db.select().from(workflowRuns).where(and(
    isNotNull(workflowRuns.blockStatuses),
    inArray(workflowRuns.status, ["success", "failed"]),
    ...definition,
  )).orderBy(desc(sql`coalesce(${workflowRuns.completedAt}, ${workflowRuns.updatedAt})`))
    .limit(1).then(([row]) => row);
}
