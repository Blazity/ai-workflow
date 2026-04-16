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
  findPR,
  getPRCommits,
  getPRFiles,
  addPRComment,
  closePR,
  deleteBranch,
} from "../helpers/github.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/redis.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-3: Review feedback triggers a fix cycle [GitHub]
 *
 * When a developer leaves review comments on the agent's PR and moves
 * the ticket back to AI, the agent addresses the feedback and pushes
 * updates to the same PR — no duplicate PR created.
 *
 * Setup uses GitHub API to create branch + code + PR in seconds,
 * instead of waiting for a full workflow run.
 */
describe("US-3: Review feedback triggers a fix cycle", () => {
  let ticketKey: string;
  let branchName: string;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (prNumber) await closePR(prNumber);
    if (branchName) await deleteBranch(branchName);
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("addresses review comments and pushes updates to the same PR", async () => {
    // --- Setup: create ticket + branch + initial code + PR via GitHub API ---

    const ticket = await createTestTicket({
      summary: "[E2E] Add GET /api/ping endpoint",
      description: [
        "Add a GET /api/ping API route that returns { ping: 'pong' } with status 200.",
        "Create only one route file at app/api/ping/route.ts.",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // Create branch with a simple implementation
    await createBranch(branchName);
    await createOrUpdateFile(
      branchName,
      "app/api/ping/route.ts",
      [
        'import { NextResponse } from "next/server";',
        "",
        "export async function GET() {",
        '  return NextResponse.json({ ping: "pong" });',
        "}",
        "",
      ].join("\n"),
      "feat: add GET /api/ping endpoint",
    );

    // Create PR and record initial commit count
    const pr = await openPR(
      branchName,
      `[${ticketKey}] Add GET /api/ping endpoint`,
    );
    prNumber = pr.number;

    const commitsBefore = await getPRCommits(prNumber);
    const commitCountBefore = commitsBefore.length;

    // Add a review comment requesting a rename
    await addPRComment(
      prNumber,
      'Rename the `/ping` endpoint to `/healthcheck` — remove the old `/ping` route entirely and create `/healthcheck` instead.',
    );

    // --- Act: move ticket to AI to trigger the review-fix workflow ---

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // Poke cron to ensure dispatch if webhook didn't fire
    await callCronPoll();

    // --- Assert ---

    // Ticket moves to AI Review (workflow completed)
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_AI_REVIEW ? status : null;
      },
      {
        description: `ticket → ${e2eEnv.COLUMN_AI_REVIEW} after review-fix`,
        timeoutMs: 2_000_000,
      },
    );

    // PR has more commits than before the review fix
    const commitsAfter = await getPRCommits(prNumber);
    expect(commitsAfter.length).toBeGreaterThan(commitCountBefore);

    // No duplicate PR — same PR number is still the only open PR for this branch
    const currentPR = await findPR(branchName);
    expect(currentPR).not.toBeNull();
    expect(currentPR!.number).toBe(prNumber);

    // Old /ping route removed, /healthcheck exists (check PR aggregate diff)
    const prFiles = await getPRFiles(prNumber);
    const filenames = prFiles.map((f) => f.filename);
    expect(filenames.some((f) => f.includes("healthcheck"))).toBe(true);
    expect(filenames.some((f) => f.includes("/ping/"))).toBe(false);

    // Redis cleaned up
    await waitFor(
      async () => {
        const runId = await getRunId(ticketKey);
        return runId === null ? true : null;
      },
      { description: `Redis clean for ${ticketKey}`, timeoutMs: 30_000 },
    );
  });
});
