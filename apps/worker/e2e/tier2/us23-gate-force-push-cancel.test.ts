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

describe("US-23: post-pr-gate cancels previous run on force-push", () => {
  const ticketKey = `AWT-${Date.now()}-force`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("cancels old check runs when a new commit is pushed", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "first", "feat: seed");
    const pr = await openPR(branchName, "feat: add thing", "smoke");
    prNumber = pr.number;

    const firstSha = await getPRHeadSha(pr.number);

    await waitFor(
      async () => {
        const runs = await listCheckRuns(firstSha);
        return runs.some((r) => r.name === "blazebot / pr-title-format") ? runs : null;
      },
      {
        description: "first pr-title-format check run",
        timeoutMs: 60_000,
        intervalMs: 3_000,
      },
    );

    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "second", "feat: update");

    const newSha = await waitFor(
      async () => {
        const sha = await getPRHeadSha(pr.number);
        return sha !== firstSha ? sha : null;
      },
      {
        description: "PR head SHA to change after push",
        timeoutMs: 30_000,
        intervalMs: 2_000,
      },
    );

    const oldRuns = await waitFor(
      async () => {
        const runs = await listCheckRuns(firstSha);
        const check = runs.find((r) => r.name === "blazebot / pr-title-format");
        return check?.conclusion === "cancelled" ? runs : null;
      },
      {
        description: "old pr-title-format check to be cancelled",
        timeoutMs: 60_000,
        intervalMs: 3_000,
      },
    );
    expect(oldRuns).toBeTruthy();

    const newRuns = await waitFor(
      async () => {
        const runs = await listCheckRuns(newSha);
        const check = runs.find((r) => r.name === "blazebot / pr-title-format");
        return check?.status === "completed" ? runs : null;
      },
      {
        description: "new pr-title-format check to complete",
        timeoutMs: 120_000,
        intervalMs: 5_000,
      },
    );

    const newCheck = newRuns.find((r) => r.name === "blazebot / pr-title-format");
    expect(newCheck?.conclusion).toBe("success");
  });
});
