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

describe("US-25: post-pr-gate cascades remaining steps to cancelled on hard failure", () => {
  const ticketKey = `AWT-${Date.now()}-cascade`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("marks the second step as cancelled when the first fails with onFailure: fail", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    // Title does NOT match the strict pattern → first step fails → second is cancelled.
    const pr = await openPR(branchName, "chore: bump deps", "smoke");
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);
    const runs = await waitFor(
      async () => {
        const r = await listCheckRuns(sha);
        const second = r.find((c) => c.name === "blazebot / pr-title-format-permissive");
        return second?.status === "completed" ? r : null;
      },
      {
        description: "completed pr-title-format-permissive cascade check",
        timeoutMs: 120_000,
        intervalMs: 5_000,
      },
    );

    const strict = runs.find((r) => r.name === "blazebot / pr-title-format-strict");
    const permissive = runs.find((r) => r.name === "blazebot / pr-title-format-permissive");
    expect(strict?.conclusion).toBe("failure");
    expect(permissive?.conclusion).toBe("cancelled");
  });
});
