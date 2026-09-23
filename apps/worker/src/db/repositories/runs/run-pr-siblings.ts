import { repositoryCatalogKey, type RunPullRequest } from "@shared/contracts";
import { desc, sql } from "drizzle-orm";
import { getDb, type Db } from "../../client.js";
import { workflowRuns } from "../../schema.js";

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
    typeof candidate.provider === "string" &&
    candidate.provider.length > 0 &&
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
 *
 * The repository is matched by identity, not by spelling. The run recorded the
 * provider's casing (`Blazity/x`), and a run asking may hold another one
 * (`blazity/x`, from a URL somebody typed); both providers resolve paths
 * without regard to case, so an exact match answered "run_not_found" about a
 * pull request we did publish, and the fix agent refused to push to it. The
 * containment therefore narrows only on what has one spelling (the provider and
 * the number, which the GIN index still serves), and the repository is compared
 * here with the catalog's key. Numbers repeat across repositories, so every
 * candidate is read, newest first, until one of them published this one.
 */
export async function findRunPrSiblings(input: {
  db: Db;
  provider: string;
  repoPath: string;
  prNumber: number;
}): Promise<RunPrSiblingLookup> {
  const wanted = repositoryCatalogKey({ provider: input.provider, path: input.repoPath });
  try {
    const rows = await input.db
      .select({ runId: workflowRuns.runId, prs: workflowRuns.prs })
      .from(workflowRuns)
      .where(
        sql`${workflowRuns.prs} @> ${JSON.stringify([
          { provider: input.provider, id: input.prNumber },
        ])}::jsonb`,
      )
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.runId));
    for (const row of rows) {
      if (!Array.isArray(row.prs)) continue;
      const prs = row.prs.filter(isRunPullRequest);
      const current = prs.find(
        (pr) =>
          pr.id === input.prNumber &&
          repositoryCatalogKey({ provider: pr.provider, path: pr.repoPath }) === wanted,
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

export function findConnectedRunPrSiblings(
  input: Omit<Parameters<typeof findRunPrSiblings>[0], "db">,
) {
  return findRunPrSiblings({ db: getDb(), ...input });
}
