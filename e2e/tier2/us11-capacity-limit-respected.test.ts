import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
  isTicketVisibleInJql,
} from "../helpers/jira.js";
import { findPR, closePR, deleteBranch } from "../helpers/github.js";
import {
  getRunId,
  listAll as listAllRuns,
  cleanup as redisCleanup,
} from "../helpers/redis.js";
import {
  stopSandboxesForTicket,
  killClaudeForTicket,
} from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-11: Capacity limit respected
 *
 * Capacity is measured against the Redis active-runs registry, not against
 * `Sandbox.list()` — a dispatched ticket is immediately counted, so the
 * (N+1)th ticket in a batch reliably sees `at_capacity` on both the webhook
 * and cron paths.
 *
 * Flow:
 *   1. Create MAX_CONCURRENT_AGENTS + 1 tickets in quick succession.
 *   2. Move them all to AI, then wait for Jira's JQL index to reflect the
 *      transitions for every ticket.
 *   3. Trigger a cron poll. Cron discovers all AI-column tickets and fires
 *      dispatch for each in parallel; the post-claim fairness check caps
 *      started workflows at MAX_CONCURRENT_AGENTS.
 *   4. Assert: exactly N claim entries exist in the registry for our
 *      ticket set, and the overflow ticket has no entry.
 *
 * We drive dispatch from cron rather than webhooks because Jira webhook
 * delivery is unreliable under parallel transitions (and absent in CI
 * configurations without Jira admin access). Cron exercises the same
 * `dispatchTicket` path.
 *
 * Cleanup stops every sandbox and closes any PRs the N in-flight workflows
 * managed to open before we interrupted them.
 */
describe("US-11: Capacity limit respected", () => {
  const tickets: Array<{ ticketKey: string; branchName: string; prNumber?: number }> = [];

  // Clear any stale registry entries left over from prior failed runs.
  // Capacity is measured against the full registry, not just our tickets —
  // leftovers silently consume slots and starve this test of claims.
  beforeAll(async () => {
    const stale = await listAllRuns();
    if (stale.length > 0) {
      console.warn(
        `[US-11] Clearing ${stale.length} stale registry entries before test:`,
        stale.map((e) => e.ticketKey).join(", "),
      );
      await Promise.all(stale.map((e) => redisCleanup(e.ticketKey)));
    }
  });

  afterAll(async () => {
    // Cancel running workflows FIRST by moving tickets out of AI. The Jira
    // webhook then sees "left AI" and calls cancelTrackedRun, which
    // gracefully stops the workflow before any moveTicket step fires a
    // 404 on a deleted Jira issue.
    await Promise.all(
      tickets.map(async (t) => {
        try {
          const status = await getTicketStatus(t.ticketKey);
          if (status.toLowerCase() === e2eEnv.COLUMN_AI.toLowerCase()) {
            await moveTicketToColumn(t.ticketKey, e2eEnv.COLUMN_BACKLOG);
          }
        } catch {}
      }),
    );

    // Give the webhook-driven cancel path a moment to propagate before we
    // start tearing down sandboxes and tickets out from under it.
    await new Promise((r) => setTimeout(r, 5_000));

    for (const t of tickets) {
      await stopSandboxesForTicket(t.ticketKey).catch(() => {});
      if (t.prNumber) await closePR(t.prNumber).catch(() => {});
      await deleteBranch(t.branchName).catch(() => {});
      await redisCleanup(t.ticketKey).catch(() => {});
      await deleteTicket(t.ticketKey).catch(() => {});
    }
  });

  it("admits exactly MAX_CONCURRENT_AGENTS when more tickets arrive at once", async () => {
    const max = e2eEnv.MAX_CONCURRENT_AGENTS;
    const total = max + 1;

    // 1. Create N+1 tickets in parallel (all land in Backlog by default)
    const created = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        createTestTicket({
          summary: `[E2E] Capacity batch ${i + 1}/${total}`,
          description: [
            "Create a GET /api/health route that returns JSON { status: \"ok\" } with HTTP 200.",
            "",
            "Acceptance criteria:",
            "- Route file at app/api/health/route.ts",
            "- Exports a GET handler",
            '- Returns JSON response: { status: "ok" }',
          ].join("\n"),
        }),
      ),
    );
    for (const { ticketKey } of created) {
      tickets.push({ ticketKey, branchName: `blazebot/${ticketKey.toLowerCase()}` });
    }

    // 2. Move them all to AI in parallel.
    await Promise.all(
      tickets.map((t) => moveTicketToColumn(t.ticketKey, e2eEnv.COLUMN_AI)),
    );

    // 3. Wait for Jira's JQL index to reflect the transitions for every
    //    ticket. Cron's `discoverAiColumnTickets` uses JQL, so we need every
    //    ticket visible before polling — otherwise cron dispatches a subset
    //    and the fairness cap will never produce exactly `max` claims.
    await Promise.all(
      tickets.map((t) =>
        waitFor(
          async () =>
            (await isTicketVisibleInJql(t.ticketKey, e2eEnv.COLUMN_AI))
              ? true
              : null,
          {
            description: `${t.ticketKey} visible in JQL under ${e2eEnv.COLUMN_AI}`,
            timeoutMs: 60_000,
            intervalMs: 2_000,
          },
        ),
      ),
    );

    // 4. Trigger cron. It fetches all AI-column tickets via JQL and calls
    //    dispatch for each in parallel; dispatch's post-claim fairness check
    //    caps started workflows at MAX_CONCURRENT_AGENTS.
    const pollRes = await callCronPoll();
    console.log("[US-11] cron response:", JSON.stringify(pollRes.body));
    expect(pollRes.status).toBe(200);
    // Sanity: cron saw all our tickets and dispatched the cap-limit count.
    // If this fails, the real cause is visible in the logged response body
    // (e.g. `discovered < total` → JQL still stale; `started < max` →
    // capacity precheck saw a non-empty registry).
    expect(pollRes.body?.discovered).toBeGreaterThanOrEqual(total);
    expect(pollRes.body?.started).toBe(max);

    // 5. Wait for exactly `max` of our tickets to be claimed. Any `max` of
    //    the `total` can win under the fairness ordering.
    const ticketKeys = new Set(tickets.map((t) => t.ticketKey));
    const claimed = await waitFor(
      async () => {
        const all = await listAllRuns();
        const ours = all.filter((e) => ticketKeys.has(e.ticketKey));
        return ours.length === max ? ours : null;
      },
      {
        description: `${max} of ${total} tickets claimed (capacity limit)`,
        timeoutMs: 60_000,
        intervalMs: 2_000,
      },
    );

    expect(claimed.length).toBe(max);
    const claimedKeys = new Set(claimed.map((e) => e.ticketKey));
    const loserKeys = tickets.map((t) => t.ticketKey).filter((k) => !claimedKeys.has(k));
    expect(loserKeys.length).toBe(1);

    // 4. Hold the window for a few seconds to catch any late racing claim
    //    (e.g. a retry that would push us over cap). Value stays at `max`.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const all = await listAllRuns();
      const ours = all.filter((e) => ticketKeys.has(e.ticketKey));
      expect(ours.length).toBe(max);
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // 5. The losing ticket has no registry entry and no PR.
    const [loserKey] = loserKeys;
    expect(await getRunId(loserKey)).toBeNull();
    const loserBranch = `blazebot/${loserKey.toLowerCase()}`;
    expect(await findPR(loserBranch)).toBeNull();

    // 6. Capacity proven — kill claude in every winner sandbox so the
    //    test doesn't wait for full agent runs we don't care about.
    //    The workflow treats killed claude the same as US-7: sentinel
    //    with empty stdout → research `failed` → ticket moves to Backlog.
    await Promise.all(
      claimed.map(({ ticketKey }) =>
        waitFor(() => killClaudeForTicket(ticketKey), {
          description: `kill claude in winner sandbox for ${ticketKey}`,
          timeoutMs: 300_000,
          intervalMs: 10_000,
        }).catch(() => {}),
      ),
    );

    // 7. Best-effort: capture any PRs the winners managed to open so cleanup
    //    can close them.
    for (const t of tickets) {
      const pr = await findPR(t.branchName).catch(() => null);
      if (pr) t.prNumber = pr.number;
    }
  });
});
