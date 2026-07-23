import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import { deleteBranch } from "../helpers/github.js";
import {
  cleanup as redisCleanup,
  markFailed,
  isTicketFailed,
  cleanupFailed,
} from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-9: Failed marker is cleared when a ticket leaves the AI column
 *
 * Reconcile (part of the cron poll) lists all failure markers and clears any
 * whose ticket is no longer in the AI column snapshot. After clearing, the
 * ticket can be retried on a future re-entry into AI.
 *
 * The Jira webhook does NOT clear failure markers on its own — it only
 * cancels active runs. Reconcile is the sole clearer, so this test must
 * poke `/cron/poll` explicitly. The helper attaches
 * `x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}` to
 * bypass preview deployment protection (set this env var before running).
 */
describe("US-09: Failed marker cleared when ticket leaves AI", () => {
  let ticketKey: string;
  let branchName: string;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (branchName) await deleteBranch(branchName).catch(() => {});
    if (ticketKey) {
      await cleanupFailed(ticketKey);
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("clears the failure marker on reconcile when the ticket is not in AI", async () => {
    // 1. Create a ticket and move it to Backlog — anything outside AI works.
    const ticket = await createTestTicket({
      summary: "[E2E] Failed marker clears on reconcile",
      description:
        "Ticket sits outside AI; reconcile should clear the seeded failure marker.",
    });
    ticketKey = ticket.ticketKey;
    branchName = `ai-workflow/${ticketKey.toLowerCase()}`;

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_BACKLOG);

    // 2. Seed a failure marker in Redis. Backdate failedAt to sit outside
    //    the reconcile grace window (ORPHAN_GRACE_MS in reconcile.ts) so
    //    reconcile clears it on the first pass rather than treating it as
    //    a just-seeded, mid-transition marker.
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    await markFailed(ticketKey, {
      runId: "run_e2e_seeded",
      error: "seeded by e2e test",
      failedAt: oneMinuteAgo,
    });
    expect(await isTicketFailed(ticketKey)).toBe(true);

    // 3. Trigger cron — runs reconcileRuns which clears markers for tickets
    //    not in the AI column snapshot. The helper sends the bypass header,
    //    so a successful 200 confirms both auth + deployment protection are
    //    configured correctly for this run.
    const res = await callCronPoll();
    expect(res.status).toBe(200);

    // 4. Marker is cleared (allow a brief propagation window)
    await waitFor(
      async () => ((await isTicketFailed(ticketKey)) ? null : true),
      {
        description: `failure marker cleared for ${ticketKey}`,
        timeoutMs: 30_000,
      },
    );

    // 5. Ticket is still in Backlog — reconcile never moves tickets
    expect(await getTicketStatus(ticketKey)).toBe(e2eEnv.COLUMN_BACKLOG);
  });
});
