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
  setEntry,
  cleanup as redisCleanup,
} from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { e2eEnv } from "../env.js";

/**
 * US-10: Duplicate dispatch prevented by atomic claim
 *
 * When a ticket is already claimed in Redis (another dispatch won the race),
 * further dispatch attempts — from a re-fired webhook or an overlapping cron
 * poll — must return `already_claimed` and MUST NOT start a second workflow.
 *
 * Simulating two truly concurrent HTTP dispatches is brittle at the e2e layer,
 * so we seed a pre-existing claim in Redis and then trigger both dispatch
 * paths (webhook via the Jira transition, and an explicit cron poll). Each
 * path should observe the existing claim via HSETNX and skip. The atomic
 * `claim` semantics themselves are exhaustively covered by the unit tests in
 * `src/lib/dispatch.test.ts` ("only one concurrent dispatch wins when claim
 * is atomic").
 */
describe("US-10: Duplicate dispatch prevented by atomic claim", () => {
  // Seed as a claiming sentinel, not a literal runId. Reconcile's
  // cleanFinishedRun path calls `getRun(runId).status` on non-sentinel
  // values — with a fake runId that throws, the in-memory strike counter
  // on a hot Vercel function instance reaches the unreachable-strikes
  // limit quickly under parallel e2e load and unregisters the seed,
  // breaking this test's assertion. Sentinels take the
  // reconcileInflightClaim path, which leaves fresh (< STALE_CLAIM_MS)
  // claims alone while the ticket is in AI. The dispatch guard itself
  // (HSETNX on `claim()`) is agnostic to the value — any pre-existing
  // entry blocks future claims.
  const SEEDED_RUN_ID = `claiming:${Date.now()}`;
  let ticketKey: string;
  let branchName: string;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (branchName) await deleteBranch(branchName).catch(() => {});
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("skips dispatch when the ticket is already claimed in Redis", async () => {
    // 1. Create a clear ticket — would succeed on the happy path if dispatched.
    const ticket = await createTestTicket({
      summary: "[E2E] Duplicate dispatch guard",
      description: "Clear ticket; this test verifies it is NOT dispatched twice.",
    });
    ticketKey = ticket.ticketKey;
    branchName = `ai-workflow/${ticketKey.toLowerCase()}`;

    // 2. Seed an active-run entry BEFORE the ticket reaches AI. The production
    //    `claim()` uses HSETNX, so any pre-existing value blocks future claims.
    await setEntry(ticketKey, SEEDED_RUN_ID);

    // 3. Trigger the webhook-driven dispatch path by moving to AI. Jira fires
    //    the webhook; the handler calls dispatchTicket → claim() fails →
    //    returns already_claimed. Ticket stays in AI.
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // 4. Also trigger the cron-driven dispatch path explicitly. The cron
    //    discovers the ticket in AI and attempts dispatch — which must also
    //    skip for the same reason.
    await callCronPoll();

    // 5. Give both dispatch paths time to complete, then assert the Redis
    //    entry is unchanged throughout the window. If any dispatch had won
    //    the race it would overwrite the claim with a real runId.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const runId = await getRunId(ticketKey);
      expect(runId).toBe(SEEDED_RUN_ID);
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // 6. No PR was created — no workflow ever ran.
    const pr = await findPR(branchName);
    expect(pr).toBeNull();

    // 7. No sandbox running for this ticket.
    const stopped = await stopSandboxesForTicket(ticketKey);
    expect(stopped).toBe(0);

    // 8. Ticket remains in AI (skipped, not moved). Jira may return the
    //    canonical display name in different casing — match case-insensitively.
    const status = await getTicketStatus(ticketKey);
    expect(status.toLowerCase()).toBe(e2eEnv.COLUMN_AI.toLowerCase());
  });
});
