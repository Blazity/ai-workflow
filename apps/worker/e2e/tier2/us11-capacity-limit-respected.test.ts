import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  deleteTicket,
  isTicketVisibleInJql,
} from "../helpers/jira.js";
import {
  getRunId,
  setEntry,
  listAll as listAllRuns,
  cleanup as redisCleanup,
} from "../helpers/registry.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-11: Capacity limit respected
 *
 * Pre-saturates the Redis active-runs registry with MAX_CONCURRENT_AGENTS
 * dummy entries so every capacity slot is already consumed. Then creates
 * ONE real ticket and verifies dispatch rejects it — both cron and the
 * deployed scheduled cron must see the registry as full and return
 * `at_capacity` for the new ticket.
 *
 * This replaces an older approach that created MAX+1 real tickets. That
 * was correct but wasteful: with MAX=20 it spun up 20 real workflows and
 * sandboxes just to prove the cap. Pre-saturating with dummies exercises
 * the same `isAtCapacity` code path in `src/lib/dispatch.ts` without any
 * real workflow execution.
 */
describe("US-11: Capacity limit respected", () => {
  const DUMMY_PREFIX = "E2E-DUMMY-US11-";
  const dummyKeys: string[] = [];
  let ticketKey: string | null = null;

  beforeAll(async () => {
    const stale = await listAllRuns();
    if (stale.length > 0) {
      console.warn(
        `[US-11] Clearing ${stale.length} stale registry entries before saturation:`,
        stale.map((e) => e.ticketKey).join(", "),
      );
      await Promise.all(stale.map((e) => redisCleanup(e.ticketKey)));
    }

    // Seed MAX_CONCURRENT_AGENTS dummy entries with non-sentinel runIds.
    // `isAtCapacity` counts every non-sentinel entry, so these fill every
    // slot. Fresh timestamps (default `ageMs: 0`) keep reconcile's 30s
    // orphan grace from wiping them mid-test.
    for (let i = 0; i < e2eEnv.MAX_CONCURRENT_AGENTS; i++) {
      const key = `${DUMMY_PREFIX}${i}`;
      dummyKeys.push(key);
      await setEntry(key, `run_e2e_dummy_${i}`);
    }
    console.log(
      `[US-11] Seeded ${dummyKeys.length} dummy entries to saturate capacity`,
    );
  });

  afterAll(async () => {
    await Promise.all(dummyKeys.map((k) => redisCleanup(k).catch(() => {})));
    if (ticketKey) {
      await redisCleanup(ticketKey).catch(() => {});
      await deleteTicket(ticketKey).catch(() => {});
    }
  });

  it("rejects a new ticket when every capacity slot is consumed", async () => {
    // 1. Create a single real ticket and move it to AI.
    const created = await createTestTicket({
      summary: "[E2E] Capacity overflow (should be rejected)",
      description:
        "Seeded dummies saturate capacity; dispatch must reject this ticket.",
    });
    ticketKey = created.ticketKey;

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // 2. Wait for JQL to reflect the transition — cron's
    //    discoverAiColumnTickets uses a JQL search, so the ticket must be
    //    indexed before polling.
    await waitFor(
      async () =>
        (await isTicketVisibleInJql(ticketKey!, e2eEnv.COLUMN_AI))
          ? true
          : null,
      {
        description: `${ticketKey} visible in JQL under ${e2eEnv.COLUMN_AI}`,
        timeoutMs: 60_000,
        intervalMs: 2_000,
      },
    );

    // 3. Trigger cron. Dispatch's `isAtCapacity` precheck sees MAX dummies
    //    and rejects our ticket before it can claim. (The deployed
    //    scheduled cron may also have fired during the JQL wait — it hits
    //    the same at-capacity rejection, so either way no claim lands.)
    const pollRes = await callCronPoll();
    console.log("[US-11] cron response:", JSON.stringify(pollRes.body));
    expect(pollRes.status).toBe(200);
    expect(pollRes.body?.discovered).toBeGreaterThanOrEqual(1);
    expect(pollRes.body?.started).toBe(0);

    // 4. The ticket has no registry entry — capacity rejection confirmed.
    expect(await getRunId(ticketKey)).toBeNull();
  });
});
