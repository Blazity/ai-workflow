import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  closePR,
  deleteBranch,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";

describe("US-26: post-pr-gate runOn filters", () => {
  const ticketKey = `AWT-${Date.now()}-draft`;
  const branchName = `ai-workflow/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("does NOT run on draft PRs when draftPrs: false", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    const pr = await openPR(branchName, "feat: draft change", "smoke", { draft: true });
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);
    await new Promise((r) => setTimeout(r, 30_000));

    const runs = await listCheckRuns(sha);
    const managedChecks = runs.filter(
      (run) =>
        run.name.startsWith("AI Workflow / ") ||
        run.name.startsWith("blazebot / "),
    );
    expect(managedChecks).toHaveLength(0);
  });
});
