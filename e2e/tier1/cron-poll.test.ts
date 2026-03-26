import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  deleteTicket,
} from "../helpers/jira.js";
import { callCronPoll } from "../helpers/webhook.js";
import { cleanup as redisCleanup } from "../helpers/redis.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

describe("cron poll", () => {
  let ticketKey: string;

  afterAll(async () => {
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("discovers tickets in the AI column", async () => {
    const ticket = await createTestTicket();
    ticketKey = ticket.ticketKey;
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // Jira's JQL index can lag a few seconds after status changes
    const { status, body } = await waitFor(
      async () => {
        const res = await callCronPoll();
        if (res.status === 200 && res.body.discovered >= 1) return res;
        return null;
      },
      { description: "cron poll discovers ticket", timeoutMs: 30_000, intervalMs: 3_000 },
    );

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.discovered).toBeGreaterThanOrEqual(1);
  });

  it("rejects unauthenticated requests", async () => {
    const { status } = await callCronPoll({ omitAuth: true });
    expect(status).toBe(401);
  });
});
