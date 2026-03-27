import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  deleteTicket,
} from "../helpers/jira.js";
import { sendJiraWebhook, makeDispatchPayload } from "../helpers/webhook.js";
import { cleanup as redisCleanup } from "../helpers/redis.js";
import { e2eEnv } from "../env.js";

describe("duplicate dispatch", () => {
  let ticketKey: string;

  afterAll(async () => {
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("rejects a second dispatch for the same ticket", async () => {
    const ticket = await createTestTicket();
    ticketKey = ticket.ticketKey;

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    const payload = makeDispatchPayload(ticketKey);

    // First dispatch — should succeed
    const first = await sendJiraWebhook(payload);
    expect(first.body.dispatched).toBe(true);

    // Second dispatch — should be rejected as already claimed
    const second = await sendJiraWebhook(payload);
    expect(second.status).toBe(200);
    expect(second.body.dispatched).toBe(false);
    expect(second.body.reason).toBe("already_claimed");
  });
});
