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
import { waitFor } from "../helpers/wait.js";

describe("US-20: post-pr-gate pr-title-format pass", () => {
  const ticketKey = `AWT-${Date.now()}-pass`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("marks the pr-title-format check as success", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    const pr = await openPR(branchName, "feat: add new feature", "smoke");
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);
    const checks = await waitFor(
      async () => {
        const runs = await listCheckRuns(sha);
        const titleCheck = runs.find((r) => r.name === "blazebot / pr-title-format");
        return titleCheck?.status === "completed" ? runs : null;
      },
      {
        description: "completed pr-title-format success check",
        timeoutMs: 120_000,
        intervalMs: 5_000,
      },
    );

    const titleCheck = checks.find((r) => r.name === "blazebot / pr-title-format");
    expect(titleCheck?.conclusion).toBe("success");
  });
});
