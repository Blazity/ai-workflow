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
 * US-15: Orphaned run cancelled when ticket leaves AI
 *
 * Reconcile is the backup path for cleaning up runs whose ticket has left
 * the AI column. The Jira webhook normally cancels runs synchronously on
 * transition (see webhooks/jira.post.ts → cancelTrackedRun), but that path
 * can be missed if the webhook is disabled, misconfigured, or fails to
 * deliver. Reconcile catches those: it compares the AI-column snapshot
 * against the active-run registry, re-verifies each suspect ticket against
 * Jira (guards against poll lag / JQL index staleness), and calls cancelRun
 * for any confirmed orphan.
 *
 * We seed a non-sentinel runId on a Backlog ticket to isolate the reconcile
 * path without involving a real workflow. `cancelRun` swallows the
 * `getRun(…).cancel()` error when the runId doesn't exist but still
 * unregisters the Redis entry and stops any matching sandboxes — so a
 * cleared Redis entry after the cron call proves reconcile reached the
 * cancel path (it's the only site that unregisters in this state).
 */
describe("US-15: Orphaned run cancelled when ticket leaves AI", () => {
  const SEEDED_RUN_ID = "run_e2e_us15_orphan";
  let ticketKey: string;

  afterAll(async () => {
    if (ticketKey) {
      await stopSandboxesForTicket(ticketKey).catch(() => {});
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("cancels the run and clears the registry when the ticket is not in AI", async () => {
    // 1. Create a ticket and pin it outside AI. Backlog is the conventional
    //    target for our fixtures; any non-AI column triggers the same
    //    reconcile branch.
    const ticket = await createTestTicket({
      summary: "[E2E] Orphaned run reconcile",
      description: "Seeded active run; ticket not in AI; reconcile should cancel.",
    });
    ticketKey = ticket.ticketKey;

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_BACKLOG);
    expect(await getTicketStatus(ticketKey)).toBe(e2eEnv.COLUMN_BACKLOG);

    // 2. Seed a non-sentinel runId (a claiming:<ts> would trip the inflight
    //    branch instead). This simulates the "workflow registered" state
    //    where the webhook-based cancel was missed. Backdate past
    //    reconcile's ORPHAN_GRACE_MS so the first cron tick acts on it
    //    instead of skipping the entry as a fresh orphan.
    await setEntry(ticketKey, SEEDED_RUN_ID, { ageMs: 60_000 });
    expect(await getRunId(ticketKey)).toBe(SEEDED_RUN_ID);

    // 3. Trigger the cron. Reconcile walks the registry, sees our ticket is
    //    absent from the AI-column snapshot, re-fetches from Jira (confirms
    //    Backlog), and calls cancelRun → unregister.
    const res = await callCronPoll();
    expect(res.status).toBe(200);

    // 4. Redis entry cleared — evidence that reconcile reached cancelRun.
    await waitFor(
      async () => ((await getRunId(ticketKey)) === null ? true : null),
      {
        description: `orphaned run cleared for ${ticketKey}`,
        timeoutMs: 30_000,
        intervalMs: 2_000,
      },
    );

    // 5. No sandbox still running for this ticket.
    expect(await stopSandboxesForTicket(ticketKey)).toBe(0);

    // 6. Ticket stays in Backlog — reconcile never moves tickets, it only
    //    cancels and cleans up state.
    expect(await getTicketStatus(ticketKey)).toBe(e2eEnv.COLUMN_BACKLOG);
  });
});
