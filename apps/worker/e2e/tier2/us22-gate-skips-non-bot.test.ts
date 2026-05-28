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

describe("US-22: post-pr-gate skips non-blazebot branches", () => {
  const branchName = `manual/test-${Date.now()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("does not create blazebot check runs for a non-bot branch", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, "gate-fixtures/manual.md", "x", "chore: seed");
    const pr = await openPR(branchName, "feat: manual change", "smoke");
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);
    await new Promise((r) => setTimeout(r, 30_000));

    const runs = await listCheckRuns(sha);
    const blazebotChecks = runs.filter((r) => r.name.startsWith("blazebot / "));
    expect(blazebotChecks).toHaveLength(0);
  });
});
