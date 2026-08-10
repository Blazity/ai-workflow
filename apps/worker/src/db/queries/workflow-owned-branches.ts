import { and, eq, isNull, or, sql } from "drizzle-orm";
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
  /** Intended PR/MR target for the current publication intent. */
  targetBranch?: string;
  /** Dedicated publication intent writer sets this until PR correlation. */
  prCorrelationPending?: boolean;
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
    ...(row.prTargetBranch ?? row.targetBranch
      ? { targetBranch: (row.prTargetBranch ?? row.targetBranch) as string }
      : {}),
    ...(!row.prCorrelationPending && row.prId !== null && row.prUrl && row.prBranchName
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
      targetBranch: record.targetBranch,
      prId: record.pr?.id,
      prUrl: record.pr?.url,
      prBranchName: record.pr?.branch,
      prPublishedHeadSha: record.pr ? record.publishedHeadSha : undefined,
      prTargetBranch: record.pr ? record.targetBranch : undefined,
      prCorrelationPending: record.pr
        ? false
        : (record.prCorrelationPending ?? false),
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
        targetBranch: sql`coalesce(excluded.target_branch, ${workflowOwnedBranches.targetBranch})`,
        prId: sql`coalesce(excluded.pr_id, ${workflowOwnedBranches.prId})`,
        prUrl: sql`coalesce(excluded.pr_url, ${workflowOwnedBranches.prUrl})`,
        prBranchName: sql`coalesce(excluded.pr_branch_name, ${workflowOwnedBranches.prBranchName})`,
        prPublishedHeadSha: record.pr
          ? sql`coalesce(excluded.pr_published_head_sha, ${workflowOwnedBranches.prPublishedHeadSha})`
          : sql`coalesce(${workflowOwnedBranches.prPublishedHeadSha}, case when ${workflowOwnedBranches.prId} is not null then ${workflowOwnedBranches.publishedHeadSha} end)`,
        prTargetBranch: record.pr
          ? sql`coalesce(excluded.pr_target_branch, ${workflowOwnedBranches.prTargetBranch})`
          : sql`coalesce(${workflowOwnedBranches.prTargetBranch}, case when ${workflowOwnedBranches.prId} is not null then ${workflowOwnedBranches.targetBranch} end)`,
        prCorrelationPending: record.pr
          ? false
          : record.prCorrelationPending === undefined
            ? workflowOwnedBranches.prCorrelationPending
            : record.prCorrelationPending,
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
    baseBranch: string;
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
        // issue_comment events cannot know the PR branch name. Dropping only the
        // branch equality still leaves the published-head-SHA and target-branch
        // checks below, which prove the workflow itself published this head.
        input.branchName
          ? eq(workflowOwnedBranches.prBranchName, input.branchName)
          : undefined,
        or(
          eq(workflowOwnedBranches.prPublishedHeadSha, input.publishedHeadSha),
          and(
            isNull(workflowOwnedBranches.prPublishedHeadSha),
            eq(workflowOwnedBranches.publishedHeadSha, input.publishedHeadSha),
          ),
        ),
        eq(workflowOwnedBranches.prTargetBranch, input.baseBranch),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.prId === null || !row.prUrl || !row.prBranchName) return null;
  return {
    ticketKey: row.ticketKey,
    provider: row.provider as VcsProvider,
    repoPath: row.repoPath,
    branchName: row.prBranchName,
    publishedHeadSha: row.prPublishedHeadSha ?? row.publishedHeadSha ?? undefined,
    ...(row.prTargetBranch ? { targetBranch: row.prTargetBranch } : {}),
    pr: { id: row.prId, url: row.prUrl, branch: row.prBranchName },
  };
}

/**
 * Records the head a workflow publication is ABOUT to push, before it pushes.
 *
 * Anti-recursion recognises our own push by an exact sha match, and the provider
 * webhook for that push arrives within milliseconds. Writing the sha only after
 * the push therefore loses the race: the synchronize event reads the previous
 * head, is accepted as foreign, and supersedes the very run that produced it.
 * Registering the intended head first closes that window. A sha that never
 * reaches the remote (a failed push) is harmless: it can only ever match an
 * event carrying that same sha, which by definition never arrives.
 */
export async function recordWorkflowOwnedPullRequestPublishedHead(
  db: Db,
  input: {
    provider: VcsProvider;
    repoPath: string;
    prNumber: number;
    headSha: string;
  },
): Promise<boolean> {
  if (input.headSha.trim().length === 0) return false;
  const rows = await db
    .update(workflowOwnedBranches)
    .set({ prPublishedHeadSha: input.headSha, updatedAt: sql`now()` })
    .where(
      and(
        eq(workflowOwnedBranches.provider, input.provider),
        eq(workflowOwnedBranches.repoPath, input.repoPath),
        eq(workflowOwnedBranches.prId, input.prNumber),
      ),
    )
    .returning({ ticketKey: workflowOwnedBranches.ticketKey });
  return rows.length > 0;
}

/** Reads ownership by provider PR identity for webhook anti-recursion. The
 * caller compares the event head to publishedHeadSha; this query deliberately
 * does not treat a changed human head as workflow-owned. */
export async function findWorkflowOwnedPullRequestIdentity(
  db: Db,
  input: {
    provider: VcsProvider;
    repoPath: string;
    prNumber: number;
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
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.prId === null || !row.prUrl || !row.prBranchName) return null;
  return {
    ticketKey: row.ticketKey,
    provider: row.provider as VcsProvider,
    repoPath: row.repoPath,
    branchName: row.prBranchName,
    ...(row.prPublishedHeadSha ?? row.publishedHeadSha
      ? { publishedHeadSha: row.prPublishedHeadSha ?? row.publishedHeadSha! }
      : {}),
    ...(row.prTargetBranch ?? row.targetBranch
      ? { targetBranch: (row.prTargetBranch ?? row.targetBranch) as string }
      : {}),
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
    baseBranch: string;
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
        eq(workflowOwnedBranches.targetBranch, input.baseBranch),
        eq(workflowOwnedBranches.prCorrelationPending, true),
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

/**
 * Promote an authenticated, current PR-created event into the confirmed
 * correlation for an exact pending publication intent. The CAS cannot bind a
 * stale event after a newer intent or an already-confirmed PR wins the race.
 */
export async function bindWorkflowOwnedPullRequestIntent(
  db: Db,
  input: {
    ticketKey: string;
    provider: VcsProvider;
    repoPath: string;
    branchName: string;
    publishedHeadSha: string;
    baseBranch: string;
    prNumber: number;
    prUrl: string;
  },
): Promise<WorkflowOwnedBranchRecord | null> {
  if (input.prNumber <= 0 || input.prUrl.trim().length === 0) return null;
  const rows = await db
    .update(workflowOwnedBranches)
    .set({
      prId: input.prNumber,
      prUrl: input.prUrl,
      prBranchName: input.branchName,
      prPublishedHeadSha: input.publishedHeadSha,
      prTargetBranch: input.baseBranch,
      prCorrelationPending: false,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workflowOwnedBranches.ticketKey, input.ticketKey),
        eq(workflowOwnedBranches.provider, input.provider),
        eq(workflowOwnedBranches.repoPath, input.repoPath),
        eq(workflowOwnedBranches.branchName, input.branchName),
        eq(workflowOwnedBranches.publishedHeadSha, input.publishedHeadSha),
        eq(workflowOwnedBranches.targetBranch, input.baseBranch),
        eq(workflowOwnedBranches.prCorrelationPending, true),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row || row.prId === null || !row.prUrl || !row.prBranchName) return null;
  return {
    ticketKey: row.ticketKey,
    provider: row.provider as VcsProvider,
    repoPath: row.repoPath,
    branchName: row.branchName,
    ...(row.publishedHeadSha ? { publishedHeadSha: row.publishedHeadSha } : {}),
    ...(row.targetBranch ? { targetBranch: row.targetBranch } : {}),
    pr: { id: row.prId, url: row.prUrl, branch: row.prBranchName },
  };
}
