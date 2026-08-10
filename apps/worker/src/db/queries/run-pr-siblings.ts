import type { RunPullRequest } from "@shared/contracts";
import { desc, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { workflowRuns } from "../schema.js";

export type RunPrSiblingLookup =
  | {
      status: "siblings";
      runId: string;
      current: RunPullRequest;
      siblings: RunPullRequest[];
    }
  | { status: "none"; runId: string; current: RunPullRequest }
  | { status: "unknown"; reason: string };

function isRunPullRequest(value: unknown): value is RunPullRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.provider === "github" || candidate.provider === "gitlab") &&
    typeof candidate.repoPath === "string" &&
    typeof candidate.id === "number" &&
    typeof candidate.url === "string"
  );
}

/**
 * Finds the durable run that opened a PR/MR and returns the other PRs from the
 * same publication. A missing row and a database failure deliberately remain
 * distinguishable: callers use this lookup fail-open for review context but
 * fail-closed for workflow-owned pushes.
 */
export async function findRunPrSiblings(input: {
  db: Db;
  provider: "github" | "gitlab";
  repoPath: string;
  prNumber: number;
}): Promise<RunPrSiblingLookup> {
  try {
    const rows = await input.db
      .select({ runId: workflowRuns.runId, prs: workflowRuns.prs })
      .from(workflowRuns)
      .where(
        sql`${workflowRuns.prs} @> ${JSON.stringify([
          {
            provider: input.provider,
            repoPath: input.repoPath,
            id: input.prNumber,
          },
        ])}::jsonb`,
      )
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.runId))
      .limit(1);
    for (const row of rows) {
      if (!Array.isArray(row.prs)) continue;
      const prs = row.prs.filter(isRunPullRequest);
      const current = prs.find(
        (pr) =>
          pr.provider === input.provider &&
          pr.repoPath === input.repoPath &&
          pr.id === input.prNumber,
      );
      if (!current) continue;
      const siblings = prs.filter((pr) => pr !== current);
      return siblings.length > 0
        ? { status: "siblings", runId: row.runId, current, siblings }
        : { status: "none", runId: row.runId, current };
    }
    return { status: "unknown", reason: "run_not_found" };
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
