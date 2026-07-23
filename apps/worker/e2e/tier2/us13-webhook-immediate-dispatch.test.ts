import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import { findPR, closePR, deleteBranch } from "../helpers/github.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-13: Webhook-triggered immediate dispatch
 *
 * When Jira fires a status-change webhook, dispatch must run immediately —
 * not after the next cron tick. We assert this by moving the ticket to AI
 * and watching for the Redis claim to appear well inside a single cron
 * interval (cron runs every 60s; we bound this test at 30s).
 *
 * We intentionally do NOT call `callCronPoll()` — if the claim appears, it
 * can only have come from the webhook path.
 */
describe("US-13: Webhook-triggered immediate dispatch", () => {
  const WEBHOOK_WINDOW_MS = 30_000;
  let ticketKey: string;
  let branchName: string;
  let prNumber: number | undefined;

  afterAll(async () => {
    // The test returns as soon as the claim appears — the workflow is still
    // running. Cancel it by moving the ticket out of AI: the Jira webhook
    // then calls cancelTrackedRun, which stops the workflow gracefully
    // before its moveTicket step can 404 on a deleted issue.
    if (ticketKey) {
      try {
        const status = await getTicketStatus(ticketKey);
        if (status.toLowerCase() === e2eEnv.COLUMN_AI.toLowerCase()) {
          await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_BACKLOG);
        }
      } catch {}
      // Settling window for webhook-cancel → run.cancel → sandbox teardown.
      await new Promise((r) => setTimeout(r, 5_000));
      await stopSandboxesForTicket(ticketKey).catch(() => {});
    }
    if (prNumber) await closePR(prNumber).catch(() => {});
    if (branchName) await deleteBranch(branchName).catch(() => {});
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("claims the ticket within seconds of a Jira status-change webhook", async () => {
    // 1. Create a clear ticket; we only care about dispatch latency, not the
    //    workflow result — but using a clear description keeps the agent from
    //    immediately bailing into a clarification path.
    const ticket = await createTestTicket({
      summary: "[E2E] Webhook immediate dispatch",
      description: [
        "Create a GET /api/health route that returns JSON { status: \"ok\" } with HTTP 200.",
        "",
        "Acceptance criteria:",
        "- Route file at app/api/health/route.ts",
        "- Exports a GET handler",
        '- Returns JSON response: { status: "ok" }',
        "- HTTP 200 response",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `ai-workflow/${ticketKey.toLowerCase()}`;

    // 2. Move to AI — Jira fires the webhook. No cron poll is invoked, so any
    //    claim we observe must be attributable to the webhook path.
    const start = Date.now();
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // 3. The dispatch handler HSETNX's a `claiming:<ts>` sentinel first, then
    //    overwrites with the real runId once the workflow starts. Either is
    //    sufficient evidence that dispatch ran — fail fast at 30s, well short
    //    of a 60s cron cycle.
    const runId = await waitFor(
      async () => {
        const current = await getRunId(ticketKey);
        return current ?? null;
      },
      {
        description: `webhook-triggered claim for ${ticketKey}`,
        timeoutMs: WEBHOOK_WINDOW_MS,
        intervalMs: 1_000,
      },
    );

    const elapsedMs = Date.now() - start;
    expect(runId).toBeTruthy();
    expect(elapsedMs).toBeLessThan(WEBHOOK_WINDOW_MS);

    // 4. Best-effort: capture the PR number if the workflow happens to finish
    //    before afterAll runs, so cleanup can close it cleanly.
    const pr = await findPR(branchName).catch(() => null);
    if (pr) prNumber = pr.number;
  });
});
