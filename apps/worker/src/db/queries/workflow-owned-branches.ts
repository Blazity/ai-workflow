import { eq, sql } from "drizzle-orm";
import type { VcsProvider } from "../../adapters/vcs/repository-directory.js";
import type { Db } from "../client.js";
import { workflowOwnedBranches } from "../schema.js";

export interface WorkflowOwnedBranchRecord {
  ticketKey: string;
  provider: VcsProvider;
  repoPath: string;
  branchName: string;
  pr?: {
    id: number;
    url: string;
    branch: string;
  };
}

export async function listWorkflowOwnedBranchesForTicket(
  db: Db,
  ticketKey: string,
): Promise<WorkflowOwnedBranchRecord[]> {
  const rows = await db
    .select()
    .from(workflowOwnedBranches)
    .where(eq(workflowOwnedBranches.ticketKey, ticketKey));

  return rows.map((row) => ({
    ticketKey: row.ticketKey,
    provider: row.provider as VcsProvider,
    repoPath: row.repoPath,
    branchName: row.branchName,
    ...(row.prId !== null && row.prUrl && row.prBranchName
      ? { pr: { id: row.prId, url: row.prUrl, branch: row.prBranchName } }
      : {}),
  }));
}

export async function upsertWorkflowOwnedBranch(
  db: Db,
  record: WorkflowOwnedBranchRecord,
): Promise<void> {
  await db
    .insert(workflowOwnedBranches)
    .values({
      ticketKey: record.ticketKey,
      provider: record.provider,
      repoPath: record.repoPath,
      branchName: record.branchName,
      prId: record.pr?.id,
      prUrl: record.pr?.url,
      prBranchName: record.pr?.branch,
    })
    .onConflictDoUpdate({
      target: [
        workflowOwnedBranches.ticketKey,
        workflowOwnedBranches.provider,
        workflowOwnedBranches.repoPath,
      ],
      set: {
        branchName: record.branchName,
        prId: sql`coalesce(excluded.pr_id, ${workflowOwnedBranches.prId})`,
        prUrl: sql`coalesce(excluded.pr_url, ${workflowOwnedBranches.prUrl})`,
        prBranchName: sql`coalesce(excluded.pr_branch_name, ${workflowOwnedBranches.prBranchName})`,
        updatedAt: sql`now()`,
      },
    });
}
