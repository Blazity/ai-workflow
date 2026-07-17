import { and, eq, sql } from "drizzle-orm";
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

export async function findWorkflowOwnedPullRequest(
  db: Db,
  input: {
    provider: VcsProvider;
    repoPath: string;
    prNumber: number;
    branchName: string;
  },
): Promise<WorkflowOwnedBranchRecord | null> {
  const rows = await db
    .select()
    .from(workflowOwnedBranches)
    .where(
      and(
        eq(workflowOwnedBranches.provider, input.provider),
        eq(workflowOwnedBranches.repoPath, input.repoPath),
        eq(workflowOwnedBranches.prId, input.prNumber),
        eq(workflowOwnedBranches.branchName, input.branchName),
        eq(workflowOwnedBranches.prBranchName, input.branchName),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.prId === null || !row.prUrl || !row.prBranchName) return null;
  return {
    ticketKey: row.ticketKey,
    provider: row.provider as VcsProvider,
    repoPath: row.repoPath,
    branchName: row.branchName,
    pr: { id: row.prId, url: row.prUrl, branch: row.prBranchName },
  };
}
