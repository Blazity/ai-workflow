import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import {
  getRunId,
  setEntry,
  cleanup as redisCleanup,
} from "../helpers/redis.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-14: Stale claim cleaned up
 *
 * If a dispatch process crashes after calling `claim()` but before the
 * workflow actually starts, the `claiming:<ts>` sentinel is left behind in
 * Redis. Because `claim()` uses HSETNX, that stale entry would block every
 * future dispatch for the same ticket. Reconcile's job is to sweep any
 * sentinel older than STALE_CLAIM_MS (5 min) so the ticket becomes
 * dispatchable again on the next poll.
 *
 * We seed the stale sentinel directly — forcing a real dispatch crash mid-
 * claim at the e2e layer is impractical, and the reconcile path doesn't care
 * how the sentinel got there. The ticket stays in Backlog throughout: the
 * cleanup rule fires on claim age alone, regardless of column.
 */
describe("US-14: Stale claim cleaned up", () => {
  let ticketKey: string;

  afterAll(async () => {
    // Defensive sandbox sweep: the stale-claim scenario assumes dispatch
    // crashed "before starting a workflow" (user story wording), so no
    // sandbox should exist. Production reconcile also does NOT stop
    // sandboxes on the stale-sentinel path (reconcileInflightClaim only
    // unregisters). If something does slip through — e.g. a crash between
    // `start()` and `register()` in dispatch — only this cleanup will catch
    // it, since nothing else in the test does.
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("removes a claiming sentinel older than 5 minutes on reconcile", async () => {
    // 1. Create a ticket and pin it to Backlog. Not strictly required for
    //    the stale-claim rule (cleanup fires on age alone), but pinning
    //    away from AI prevents a just-in-time dispatch from racing us: if
    //    the project's default column ever becomes AI, the webhook would
    //    otherwise fire on create and try to dispatch.
    const ticket = await createTestTicket({
      summary: "[E2E] Stale claim cleanup",
      description: "Seeded stale claim; reconcile should clean it up.",
    });
    ticketKey = ticket.ticketKey;
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_BACKLOG);
    expect(await getTicketStatus(ticketKey)).toBe(e2eEnv.COLUMN_BACKLOG);

    // 2. Seed a `claiming:<ts>` sentinel timestamped 6 minutes ago — safely
    //    past the 5-minute STALE_CLAIM_MS threshold in src/lib/reconcile.ts.
    const staleTimestamp = Date.now() - 6 * 60 * 1000;
    const staleClaim = `claiming:${staleTimestamp}`;
    await setEntry(ticketKey, staleClaim);
    expect(await getRunId(ticketKey)).toBe(staleClaim);

    // 3. Trigger the cron — reconcileRuns is invoked after dispatch and
    //    iterates active runs; our stale sentinel matches the age check.
    const res = await callCronPoll();
    expect(res.status).toBe(200);

    // 4. Redis entry is gone. Once unregistered, HSETNX will succeed on
    //    the next dispatch — the "next dispatch succeeds" verification in
    //    the user story follows directly from the entry being absent, and
    //    HSETNX semantics are covered by US-10 and the dispatch unit tests.
    await waitFor(
      async () => ((await getRunId(ticketKey)) === null ? true : null),
      {
        description: `stale claim cleared for ${ticketKey}`,
        timeoutMs: 30_000,
        intervalMs: 2_000,
      },
    );

    // 5. No sandbox matching this ticket. The user story doesn't list this
    //    explicitly (the scenario assumes "crashed before starting a
    //    workflow"), but we assert it anyway so a regression where the
    //    stale-claim path leaks sandboxes surfaces here — see note in
    //    afterAll about the production gap.
    expect(await stopSandboxesForTicket(ticketKey)).toBe(0);
  });
});
