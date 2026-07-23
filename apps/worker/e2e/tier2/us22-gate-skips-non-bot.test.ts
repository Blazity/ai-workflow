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

describe("US-22: post-pr-gate skips non-managed branches", () => {
  const branchName = `manual/test-${Date.now()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("does not create current or legacy managed checks for a non-bot branch", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, "gate-fixtures/manual.md", "x", "chore: seed");
    const pr = await openPR(branchName, "feat: manual change", "smoke");
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
