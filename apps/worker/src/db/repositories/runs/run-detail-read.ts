import { eq, getTableColumns } from "drizzle-orm";
import type { Db } from "../../client.js";
import { getDb } from "../../client.js";
import { workflowRuns } from "../../schema.js";
import { runWorkflowLabel } from "./workflow-label.js";

export async function readRunDetailRow(db: Db, runId: string) {
  const rows = await db
    .select({ ...getTableColumns(workflowRuns), workflowName: runWorkflowLabel })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return rows[0] ?? null;
}

export async function readRunRefsRow(db: Db, runId: string) {
  const rows = await db
    .select({
      ticketKey: workflowRuns.ticketKey,
      ticketUrl: workflowRuns.ticketUrl,
      ticketTitle: workflowRuns.ticketTitle,
      prNumber: workflowRuns.prNumber,
      prUrl: workflowRuns.prUrl,
      prs: workflowRuns.prs,
      statusReason: workflowRuns.statusReason,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return rows[0] ?? null;
}

export function readConnectedRunDetailRow(runId: string) {
  return readRunDetailRow(getDb(), runId);
}

export function readConnectedRunRefsRow(runId: string) {
  return readRunRefsRow(getDb(), runId);
}
