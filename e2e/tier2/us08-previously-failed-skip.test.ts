import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import { findPR, deleteBranch } from "../helpers/github.js";
import {
  getRunId,
  cleanup as redisCleanup,
  markFailed,
  isTicketFailed,
  cleanupFailed,
} from "../helpers/redis.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-8: Previously-failed ticket is skipped on re-poll
 *
 * A ticket with a Redis failure marker must not be re-dispatched even while
 * it sits in the AI column — the dispatch precheck returns
 * `previously_failed` and no workflow is started.
 *
 * We seed the failure marker directly because its only production trigger is
 * the workflow's catch-block safeguard (Jira unreachable during error
 * recovery), which is impractical to force in e2e.
 *
 * Both dispatch paths must honour the marker: the webhook path (fires when
 * the ticket enters AI) and the cron re-poll path (fires on every tick
 * while the ticket sits in AI). This test exercises both.
 */
describe("US-08: Previously-failed ticket is skipped", () => {
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

  it("does not dispatch a workflow for a ticket marked failed", async () => {
    // 1. Create a clear ticket — would succeed if dispatched
    const ticket = await createTestTicket({
      summary: "[E2E] Previously-failed skip guard",
      description: "Clear ticket; this test verifies it is NOT dispatched.",
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // 2. Seed the failure marker in Redis (simulates the catch-block safeguard)
    await markFailed(ticketKey, {
      runId: "run_e2e_seeded",
      error: "seeded by e2e test",
      failedAt: new Date().toISOString(),
    });

    // 3. Move to AI column — Jira webhook triggers dispatch, which must skip
    //    because the failure marker is present.
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // 4. Explicitly poke the cron re-poll path — this is the scenario US-8
    //    is primarily about. Cron discovers the ticket (still in AI), calls
    //    dispatchTicket, and the failed-marker precheck returns
    //    `previously_failed`. The response body confirms both auth and
    //    deployment-protection bypass are configured correctly.
    const cronRes = await callCronPoll();
    expect(cronRes.status).toBe(200);

    // 5. Give both dispatch paths time to run, then assert that no active-run
    //    Redis entry was ever created. We poll for the full window rather
    //    than a single check to catch any claim that might appear mid-window
    //    (e.g. from a retry).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const runId = await getRunId(ticketKey);
      expect(runId).toBeNull();
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // 5. Failure marker still present — reconcile only clears it when the
    //    ticket has *left* the AI column (US-9 covers that path)
    expect(await isTicketFailed(ticketKey)).toBe(true);

    // 6. No PR and no sandbox for this ticket
    const pr = await findPR(branchName);
    expect(pr).toBeNull();
    const stopped = await stopSandboxesForTicket(ticketKey);
    expect(stopped).toBe(0);

    // 7. Ticket remains in AI column (skipped, not moved). Jira returns the
    //    canonical display name, which may differ in case from COLUMN_AI —
    //    production code lowercases on both sides for comparison.
    const status = await getTicketStatus(ticketKey);
    expect(status.toLowerCase()).toBe(e2eEnv.COLUMN_AI.toLowerCase());
  });
});
