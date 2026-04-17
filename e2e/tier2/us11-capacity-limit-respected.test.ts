import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import { findPR, closePR, deleteBranch } from "../helpers/github.js";
import {
  getRunId,
  listAll as listAllRuns,
  cleanup as redisCleanup,
} from "../helpers/redis.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
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
 *   2. Move them all to AI. Each move fires a Jira webhook that calls
 *      dispatch; the first N claim Redis slots and start workflows, the
 *      (N+1)th hits the cap and is skipped.
 *   3. Assert: exactly N claim entries exist in the registry for our
 *      ticket set, and the overflow ticket has no entry.
 *
 * Cleanup stops every sandbox and closes any PRs the N in-flight workflows
 * managed to open before we interrupted them.
 */
describe("US-11: Capacity limit respected", () => {
  const tickets: Array<{ ticketKey: string; branchName: string; prNumber?: number }> = [];

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

    // 2. Move them all to AI in parallel. Jira fires a webhook per transition;
    //    each webhook triggers dispatch, which claims Redis via HSETNX. The
    //    registry-based capacity check rejects the overflow ticket.
    await Promise.all(
      tickets.map((t) => moveTicketToColumn(t.ticketKey, e2eEnv.COLUMN_AI)),
    );

    // 3. Wait for exactly `max` of our tickets to be claimed. We poll the
    //    registry rather than the per-ticket entry because the Jira webhook
    //    ordering is not guaranteed — any `max` of the `total` can win.
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

    // 6. Best-effort: capture any PRs the winners managed to open so cleanup
    //    can close them.
    for (const t of tickets) {
      const pr = await findPR(t.branchName).catch(() => null);
      if (pr) t.prNumber = pr.number;
    }
  });
});
