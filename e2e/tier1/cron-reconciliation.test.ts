import { describe, it, expect, afterAll } from "vitest";
import { callCronPoll } from "../helpers/webhook.js";
import {
  setEntry,
  getRunId,
  cleanup as redisCleanup,
} from "../helpers/redis.js";

describe("cron reconciliation", () => {
  // Use a ticket key that definitely doesn't exist in the AI column
  const fakeTicketKey = `E2E-STALE-${Date.now()}`;
  const fakeRunId = "stale-run-id-for-reconciliation";

  afterAll(async () => {
    await redisCleanup(fakeTicketKey);
  });

  it("cleans up stale Redis entries for tickets not in AI column", async () => {
    // Insert a fake stale entry directly into Redis
    await setEntry(fakeTicketKey, fakeRunId);

    // Verify it's there
    const before = await getRunId(fakeTicketKey);
    expect(before).toBe(fakeRunId);

    // Trigger poll — it should reconcile and clean up the stale entry
    const { status, body } = await callCronPoll();

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.cancelled + body.cleaned).toBeGreaterThanOrEqual(1);

    // The real assertion: Redis entry is gone after reconciliation
    const after = await getRunId(fakeTicketKey);
    expect(after).toBeNull();
  });
});
