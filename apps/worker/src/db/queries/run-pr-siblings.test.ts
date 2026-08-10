import { beforeEach, describe, expect, it } from "vitest";
import type { RunPullRequest } from "@shared/contracts";
import { createTestDb } from "../test-db.js";
import type { Db } from "../client.js";
import { workflowRuns } from "../schema.js";
import { publicationPrsForTelemetry } from "../../workflows/publication-prs-for-telemetry.js";
import { findRunPrSiblings } from "./run-pr-siblings.js";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const githubPr = (repoPath: string, id: number): RunPullRequest => ({
  provider: "github",
  repoPath,
  id,
  url: `https://github.test/${repoPath}/pull/${id}`,
  headSha: "after",
});

const gitlabPr = (repoPath: string, id: number): RunPullRequest => ({
  provider: "gitlab",
  repoPath,
  id,
  url: `https://gitlab.test/${repoPath}/-/merge_requests/${id}`,
  headSha: "after",
});

async function seed(prs: RunPullRequest[]): Promise<void> {
  const persistedPrs = publicationPrsForTelemetry({
    status: "published",
    prs: prs.map((pr) => ({ ...pr, branch: "blazebot/aiw-1", isNew: true })),
    repositories: prs.map((pr) => ({
      provider: pr.provider,
      repoPath: pr.repoPath,
      branchName: "blazebot/aiw-1",
      defaultBranch: "main",
      expectedHead: "before",
      pushedHead: pr.headSha ?? "after",
    })),
  });
  await db.insert(workflowRuns).values({
    runId: "run-siblings",
    workflowId: "workflow",
    workflowName: "Workflow",
    status: "success",
    ticketKey: "AIW-1",
    ticketTitle: "Sibling PRs",
    model: "claude",
    prs: persistedPrs,
  });
}

describe("findRunPrSiblings", () => {
  it("round-trips GitHub PRs from the persisted writer shape", async () => {
    await seed([githubPr("acme/web", 12), githubPr("acme/api", 13)]);

    await expect(
      findRunPrSiblings({
        db,
        provider: "github",
        repoPath: "acme/web",
        prNumber: 12,
      }),
    ).resolves.toEqual({
      status: "siblings",
      runId: "run-siblings",
      current: githubPr("acme/web", 12),
      siblings: [githubPr("acme/api", 13)],
    });
  });

  it("round-trips nested GitLab MRs and distinguishes a single PR", async () => {
    await seed([gitlabPr("group/platform/web", 4)]);

    await expect(
      findRunPrSiblings({
        db,
        provider: "gitlab",
        repoPath: "group/platform/web",
        prNumber: 4,
      }),
    ).resolves.toMatchObject({
      status: "none",
      runId: "run-siblings",
      current: gitlabPr("group/platform/web", 4),
    });
  });

  it("returns unknown when the run is absent and when the query fails", async () => {
    await expect(
      findRunPrSiblings({
        db,
        provider: "github",
        repoPath: "missing/repo",
        prNumber: 1,
      }),
    ).resolves.toEqual({ status: "unknown", reason: "run_not_found" });

    const failingDb = {
      select: () => {
        throw new Error("database unavailable");
      },
    } as unknown as Db;
    await expect(
      findRunPrSiblings({
        db: failingDb,
        provider: "github",
        repoPath: "acme/web",
        prNumber: 12,
      }),
    ).resolves.toEqual({
      status: "unknown",
      reason: "database unavailable",
    });
  });
});
