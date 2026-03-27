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
import {
  cleanup as redisCleanup,
  getRunId,
  setEntry,
} from "../helpers/redis.js";
import { e2eEnv } from "../env.js";

describe("race conditions", () => {
  const ticketKeys: string[] = [];

  afterAll(async () => {
    await Promise.all(
      ticketKeys.map((key) =>
        Promise.all([redisCleanup(key), deleteTicket(key)]),
      ),
    );
  });

  it("allows only one winner when two dispatches fire concurrently", async () => {
    const ticket = await createTestTicket();
    ticketKeys.push(ticket.ticketKey);
    await moveTicketToColumn(ticket.ticketKey, e2eEnv.COLUMN_AI);

    const payload = makeDispatchPayload(ticket.ticketKey);

    const [a, b] = await Promise.all([
      sendJiraWebhook(payload),
      sendJiraWebhook(payload),
    ]);

    const results = [a, b];
    const winners = results.filter((r) => r.body.dispatched === true);
    const losers = results.filter((r) => r.body.dispatched === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].body.reason).toBe("already_claimed");
    expect(losers[0].status).toBe(200);
    expect(winners[0].status).toBe(200);
    expect(winners[0].body).toMatchObject({ dispatched: true });
    const redisEntry = await getRunId(ticket.ticketKey);
    expect(redisEntry).not.toBeNull();
  });

  it("clears an inflight claiming sentinel when cancel arrives", async () => {
    const ticket = await createTestTicket();
    ticketKeys.push(ticket.ticketKey);

    const sentinelValue = "claiming:1234567890";
    await setEntry(ticket.ticketKey, sentinelValue);

    const cancelPayload = makeCancelPayload(ticket.ticketKey);
    const { status, body } = await sendJiraWebhook(cancelPayload);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("cancel");
    expect(body.cancelled).toBe(true);

    const remaining = await getRunId(ticket.ticketKey);
    expect(remaining).toBeNull();
  });
});
