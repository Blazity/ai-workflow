import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  closePR,
  reopenPR,
  deleteBranch,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";
import { waitFor } from "../helpers/wait.js";

describe("US-24: post-pr-gate ignores reopened with same SHA", () => {
  const ticketKey = `AWT-${Date.now()}-reopen`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("does not create a second pr-title-format check run on reopen", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    const pr = await openPR(branchName, "feat: add thing", "smoke");
    prNumber = pr.number;
    const sha = await getPRHeadSha(pr.number);

    await waitFor(
      async () => {
        const runs = await listCheckRuns(sha);
        const check = runs.find((r) => r.name === "blazebot / pr-title-format");
        return check?.status === "completed" ? runs : null;
      },
      {
        description: "initial pr-title-format check to complete",
        timeoutMs: 120_000,
        intervalMs: 5_000,
      },
    );

    const beforeCount = (await listCheckRuns(sha))
      .filter((r) => r.name === "blazebot / pr-title-format").length;
    expect(beforeCount).toBe(1);

    await closePR(pr.number);
    await reopenPR(pr.number);
    await new Promise((r) => setTimeout(r, 30_000));

    const afterCount = (await listCheckRuns(sha))
      .filter((r) => r.name === "blazebot / pr-title-format").length;
    expect(afterCount).toBe(1);
  });
});
