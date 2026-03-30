import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  getTicketComments,
  deleteTicket,
} from "../helpers/jira.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/redis.js";
import { deleteBranch } from "../helpers/github.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

describe("clarification flow", () => {
  let ticketKey: string;
  let branchName: string;

  afterAll(async () => {
    if (branchName) await deleteBranch(branchName);
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("moves a vague ticket to Backlog with clarification questions", async () => {
    const ticket = await createTestTicket({
      summary: `[E2E] Do the thing`,
      description: "Do the thing",
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // Move to AI column and dispatch via cron poll
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);
    const { body } = await waitFor(
      async () => {
        const res = await callCronPoll();
        if (res.status === 200 && res.body.started?.includes(ticketKey)) return res;
        return null;
      },
      { description: `cron dispatches ${ticketKey}`, timeoutMs: 30_000, intervalMs: 3_000 },
    );
    expect(body.status).toBe("ok");

    // Wait for ticket to move to Backlog (clarification needed)
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_BACKLOG ? status : null;
      },
      {
        description: `ticket ${ticketKey} moved to ${e2eEnv.COLUMN_BACKLOG}`,
        timeoutMs: 2_100_000,
      },
    );

    // Verify ticket has a comment with questions
    const comments = await getTicketComments(ticketKey);
    const clarificationComment = comments.find(
      (c) => /\d+\./.test(c.body), // Contains numbered items like "1. ..."
    );
    expect(clarificationComment).toBeDefined();

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
});
