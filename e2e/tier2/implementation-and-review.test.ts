import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import {
  findPR,
  getPRCommits,
  addPRComment,
  closePR,
  deleteBranch,
} from "../helpers/github.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/redis.js";
import { sendJiraWebhook, makeDispatchPayload } from "../helpers/webhook.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

describe("implementation happy path → review-fix flow", () => {
  let ticketKey: string;
  let branchName: string;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    if (branchName) await deleteBranch(branchName);
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("implements a ticket and creates a PR", async () => {
    // Create a ticket with a simple, concrete task
    const ticket = await createTestTicket({
      summary: `[E2E] Add GET /ping endpoint`,
      description:
        "Add a GET /api/ping API route that returns { ping: 'pong' } with status 200. Create only one route file at app/api/ping/route.ts.",
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // Move to AI column and dispatch
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);
    const payload = makeDispatchPayload(ticketKey);
    const { body } = await sendJiraWebhook(payload);
    expect(body.dispatched).toBe(true);

    // Wait for PR to appear (up to 35 min)
    const pr = await waitFor(() => findPR(branchName), {
      description: `PR for branch ${branchName}`,
      timeoutMs: 2_100_000,
    });
    prNumber = pr.number;

    // Verify PR has commits
    const commits = await getPRCommits(prNumber);
    expect(commits.length).toBeGreaterThan(0);

    // Verify ticket moved to AI Review
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_AI_REVIEW ? status : null;
      },
      {
        description: `ticket ${ticketKey} moved to ${e2eEnv.COLUMN_AI_REVIEW}`,
        timeoutMs: 60_000,
      },
    );

    // Verify Redis entry is cleaned up
    await waitFor(
      async () => {
        const runId = await getRunId(ticketKey);
        return runId === null ? true : null;
      },
      {
        description: `Redis entry cleaned for ${ticketKey}`,
        timeoutMs: 30_000,
      },
    );
  });

  it("fixes PR based on review feedback", async () => {
    // This test depends on the previous test having created a PR
    expect(prNumber).toBeDefined();

    // Record commit count before review-fix
    const commitsBefore = await getPRCommits(prNumber!);
    const commitCountBefore = commitsBefore.length;

    // Add a review comment
    await addPRComment(
      prNumber!,
      "Rename the `/ping` endpoint to `/healthcheck` — remove the old `/ping` route and update its handler, tests, and any references so only `/healthcheck` exists.",
    );

    // Move ticket back to AI column and dispatch review-fix
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);
    const payload = makeDispatchPayload(ticketKey);
    const { body } = await sendJiraWebhook(payload);
    expect(body.dispatched).toBe(true);

    // Wait for ticket to move back to AI Review (review-fix completed)
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_AI_REVIEW ? status : null;
      },
      {
        description: `ticket ${ticketKey} moved back to ${e2eEnv.COLUMN_AI_REVIEW} after review-fix`,
        timeoutMs: 2_100_000,
      },
    );

    // Verify PR has new commits
    const commitsAfter = await getPRCommits(prNumber!);
    expect(commitsAfter.length).toBeGreaterThan(commitCountBefore);

    // Verify Redis entry is cleaned up
    await waitFor(
      async () => {
        const runId = await getRunId(ticketKey);
        return runId === null ? true : null;
      },
      {
        description: `Redis entry cleaned for ${ticketKey} after review-fix`,
        timeoutMs: 30_000,
      },
    );
  });
});
