import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  deleteTicket,
} from "../helpers/jira.js";
import {
  sendJiraWebhook,
  makeDispatchPayload,
  makeCancelPayload,
} from "../helpers/webhook.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/redis.js";
import { e2eEnv } from "../env.js";

describe("webhook cancel", () => {
  let ticketKey: string;

  afterAll(async () => {
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("cancels a dispatched ticket when moved away from AI column", async () => {
    const ticket = await createTestTicket();
    ticketKey = ticket.ticketKey;

    // Dispatch first
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);
    const dispatchPayload = makeDispatchPayload(ticketKey);
    const dispatchRes = await sendJiraWebhook(dispatchPayload);
    expect(dispatchRes.body.dispatched).toBe(true);

    // Wait for Redis entry
    await new Promise((r) => setTimeout(r, 2_000));

    // Move away and send cancel webhook
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_BACKLOG);
    const cancelPayload = makeCancelPayload(ticketKey);
    const { status, body } = await sendJiraWebhook(cancelPayload);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("cancel");

    // Verify Redis entry is cleaned up
    await new Promise((r) => setTimeout(r, 2_000));
    const runId = await getRunId(ticketKey);
    expect(runId).toBeNull();
  });
});
