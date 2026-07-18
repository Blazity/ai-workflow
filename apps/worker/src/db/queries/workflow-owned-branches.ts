import { and, eq, sql } from "drizzle-orm";
import type { VcsProvider } from "../../adapters/vcs/repository-directory.js";
import type { Db } from "../client.js";
import { workflowOwnedBranches } from "../schema.js";

export interface WorkflowOwnedBranchRecord {
  ticketKey: string;
  provider: VcsProvider;
  repoPath: string;
  branchName: string;
  /** Exact branch head most recently published by AI Workflow. A later human
   * push invalidates workflow-owned remediation for that head. */
  publishedHeadSha?: string;
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
    ...(row.publishedHeadSha ? { publishedHeadSha: row.publishedHeadSha } : {}),
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
      publishedHeadSha: record.publishedHeadSha,
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
        publishedHeadSha: sql`coalesce(excluded.published_head_sha, ${workflowOwnedBranches.publishedHeadSha})`,
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
    publishedHeadSha: string;
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
        eq(workflowOwnedBranches.publishedHeadSha, input.publishedHeadSha),
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
    publishedHeadSha: row.publishedHeadSha ?? undefined,
    pr: { id: row.prId, url: row.prUrl, branch: row.prBranchName },
  };
}

/**
 * Find the exact workflow-owned branch/head that may be about to receive a PR.
 * PR identity is intentionally not part of this lookup: callers must treat a
 * row without matching PR metadata as an intent only, never as authorization
 * to dispatch.
 */
export async function findWorkflowOwnedPullRequestIntent(
  db: Db,
  input: {
    provider: VcsProvider;
    repoPath: string;
    branchName: string;
    publishedHeadSha: string;
  },
): Promise<WorkflowOwnedBranchRecord | null> {
  const rows = await db
    .select()
    .from(workflowOwnedBranches)
    .where(
      and(
        eq(workflowOwnedBranches.provider, input.provider),
        eq(workflowOwnedBranches.repoPath, input.repoPath),
        eq(workflowOwnedBranches.branchName, input.branchName),
        eq(workflowOwnedBranches.publishedHeadSha, input.publishedHeadSha),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ticketKey: row.ticketKey,
    provider: row.provider as VcsProvider,
    repoPath: row.repoPath,
    branchName: row.branchName,
    publishedHeadSha: row.publishedHeadSha ?? undefined,
    ...(row.prId !== null && row.prUrl && row.prBranchName
      ? { pr: { id: row.prId, url: row.prUrl, branch: row.prBranchName } }
      : {}),
  };
}
