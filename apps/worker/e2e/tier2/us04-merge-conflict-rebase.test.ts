import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  getPRCommits,
  getFileContent,
  isPRMergeable,
  closePR,
  deleteBranch,
  deleteFile,
} from "../helpers/github.js";
import { getRunId, cleanup as registryCleanup } from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-4: PR with merge conflicts — agent rebases [GitHub]
 *
 * When a ticket's PR has merge conflicts with main, moving the ticket
 * back to AI triggers the agent to resolve the conflicts. The sandbox
 * is provisioned with `mergeBase` so the agent can see and fix them.
 *
 * Setup uses GitHub API to create a branch, add a file, add a
 * CONFLICTING file on main, then create a PR that shows conflicts.
 */
describe("US-04: PR with merge conflicts — agent rebases", () => {
  const uniqueDir = `blazebot-e2e-${Date.now()}`;
  const conflictFile = `${uniqueDir}/data.txt`;
  let ticketKey: string;
  let branchName: string;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (prNumber) await closePR(prNumber);
    if (branchName) await deleteBranch(branchName);
    await deleteFile(
      "main",
      conflictFile,
      "[E2E] cleanup conflict test file",
    ).catch(() => {});
    if (ticketKey) {
      await registryCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("resolves merge conflicts and pushes an updated branch", async () => {
    // --- Setup: create a PR that has merge conflicts ---

    const ticket = await createTestTicket({
      summary: `[E2E] Add greeting file at ${conflictFile}`,
      description: [
        `Create a file at ${conflictFile} with a single line containing exactly: Hello from blazebot`,
        "",
        "Acceptance criteria:",
        `- File exists at path ${conflictFile}`,
        "- File contains exactly one line: Hello from blazebot",
        "- No other text or content in the file",
        "- No other files created or modified",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // Create branch and add the file with the correct content
    await createBranch(branchName);
    await createOrUpdateFile(
      branchName,
      conflictFile,
      "Hello from blazebot\n",
      "feat: add greeting file",
    );

    // Create a CONFLICTING version of the same file on main
    await createOrUpdateFile(
      "main",
      conflictFile,
      "This space is reserved\n",
      "[E2E] create conflict baseline on main",
    );

    // Create PR — will have merge conflicts since both sides added the same file
    const pr = await openPR(
      branchName,
      `[${ticketKey}] Add greeting file`,
    );
    prNumber = pr.number;

    // Wait for GitHub to detect the merge conflict
    await waitFor(
      async () => {
        const mergeable = await isPRMergeable(prNumber!);
        return mergeable === false ? true : null;
      },
      {
        description: `PR #${prNumber} detected as conflicting`,
        timeoutMs: 30_000,
        intervalMs: 3_000,
      },
    );

    const commitsBefore = await getPRCommits(prNumber);
    const commitCountBefore = commitsBefore.length;

    // --- Act: move ticket to AI to trigger conflict resolution ---

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // Poke cron to ensure dispatch if webhook didn't fire
    await callCronPoll();

    // --- Assert ---

    // Ticket moves to AI Review (workflow completed successfully)
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_AI_REVIEW ? status : null;
      },
      {
        description: `ticket → ${e2eEnv.COLUMN_AI_REVIEW} after conflict resolution`,
        timeoutMs: 2_000_000,
      },
    );

    // PR no longer has merge conflicts
    await waitFor(
      async () => {
        const mergeable = await isPRMergeable(prNumber!);
        return mergeable === true ? true : null;
      },
      {
        description: `PR #${prNumber} is now mergeable`,
        timeoutMs: 30_000,
        intervalMs: 3_000,
      },
    );

    // PR has new commits (conflict resolution commit)
    const commitsAfter = await getPRCommits(prNumber);
    expect(commitsAfter.length).toBeGreaterThan(commitCountBefore);

    // Conflict file on the branch contains the ticket's expected content
    const fileContent = await getFileContent(branchName, conflictFile);
    expect(fileContent).not.toBeNull();
    expect(fileContent!.trim()).toContain("Hello from blazebot");
    // Must not contain conflict markers
    expect(fileContent).not.toMatch(/^<{7}/m);

    // Ticket status is AI Review
    const finalStatus = await getTicketStatus(ticketKey);
    expect(finalStatus).toBe(e2eEnv.COLUMN_AI_REVIEW);

    // Registry cleaned up
    await waitFor(
      async () => {
        const runId = await getRunId(ticketKey);
        return runId === null ? true : null;
      },
      { description: `Registry clean for ${ticketKey}`, timeoutMs: 30_000 },
    );
  });
});
