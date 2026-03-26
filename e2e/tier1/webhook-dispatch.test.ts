import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  deleteTicket,
} from "../helpers/jira.js";
import { sendJiraWebhook, makeDispatchPayload } from "../helpers/webhook.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/redis.js";
import { e2eEnv } from "../env.js";

describe("webhook dispatch", () => {
  let ticketKey: string;

  afterAll(async () => {
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("dispatches a ticket when moved to AI column", async () => {
    const ticket = await createTestTicket();
    ticketKey = ticket.ticketKey;

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    const payload = makeDispatchPayload(ticketKey);
    const { status, body } = await sendJiraWebhook(payload);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("dispatch");
    expect(body.dispatched).toBe(true);

    // Give the server a moment to write to Redis
    await new Promise((r) => setTimeout(r, 2_000));

    const runId = await getRunId(ticketKey);
    expect(runId).toBeTruthy();
  });
});
