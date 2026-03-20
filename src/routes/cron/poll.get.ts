import { defineEventHandler, getHeader, createError } from "h3";
import { start, getRun } from "workflow/api";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { implementationWorkflow } from "../../workflows/implementation.js";
import { reviewFixWorkflow } from "../../workflows/review-fix.js";
import { logger } from "../../lib/logger.js";

async function getActiveSandboxCount(): Promise<number> {
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const { json } = await Sandbox.list({ limit: 100 });
    return json.sandboxes.filter((s: any) => s.status === "running").length;
  } catch {
    return 0;
  }
}

export default defineEventHandler(async (event) => {
  // Verify Vercel Cron auth
  if (env.CRON_SECRET) {
    const auth = getHeader(event, "authorization");
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
  }

  const { issueTracker, vcs, runRegistry } = createAdapters();

  // Search for tickets in AI column
  const jql = `project = ${env.JIRA_PROJECT_KEY} AND status = "${env.COLUMN_AI}"`;
  const ticketKeys = await issueTracker.searchTickets(jql);

  logger.info({ ticketCount: ticketKeys.length }, "poll_discovered_tickets");

  // Concurrency control (spec Section 8.2)
  const activeSandboxes = await getActiveSandboxCount();
  const availableSlots = Math.max(0, env.MAX_CONCURRENT_AGENTS - activeSandboxes);
  if (availableSlots === 0) {
    logger.info({ active: activeSandboxes, max: env.MAX_CONCURRENT_AGENTS }, "poll_at_capacity");
    return { status: "ok", discovered: ticketKeys.length, started: 0, reason: "at_capacity" };
  }

  const started: string[] = [];

  for (const key of ticketKeys) {
    if (started.length >= availableSlots) break;

    // Atomically claim the ticket to prevent duplicate dispatches
    const claimed = await runRegistry.claim(key, "claiming");
    if (!claimed) {
      logger.info({ ticketKey: key }, "poll_ticket_already_claimed");
      continue;
    }

    try {
      const ticket = await issueTracker.fetchTicket(key);
      const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
      const existingPR = await vcs.findPR(branchName);

      if (existingPR) {
        const handle = await start(reviewFixWorkflow, [ticket.id, branchName]);
        await runRegistry.register(ticket.identifier, handle.runId);
        logger.info(
          { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
          "workflow_started_review_fix",
        );
      } else {
        const handle = await start(implementationWorkflow, [ticket.id]);
        await runRegistry.register(ticket.identifier, handle.runId);
        logger.info(
          { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
          "workflow_started_implementation",
        );
      }

      started.push(ticket.identifier);
    } catch (err) {
      // Release the claim if dispatch failed so the ticket can be retried
      await runRegistry.unregister(key).catch(() => {});
      logger.warn(
        { ticketKey: key, error: (err as Error).message },
        "poll_ticket_dispatch_error",
      );
    }
  }

  // Reconcile registry: cancel stale runs and clean up dead entries
  const aiColumnSet = new Set(ticketKeys);
  const activeRuns = await runRegistry.listAll();
  let cancelled = 0;
  let cleaned = 0;

  for (const { ticketKey, runId } of activeRuns) {
    if (aiColumnSet.has(ticketKey)) {
      // Ticket is still in AI column — verify the run is actually alive
      try {
        const run = getRun(runId);
        const status = await run.status;
        if (status === "completed" || status === "failed" || status === "cancelled") {
          await runRegistry.unregister(ticketKey);
          logger.info({ ticketKey, runId, status }, "poll_cleaned_dead_run");
          cleaned++;
        }
      } catch {
        // Run not found or status check failed — clean up so ticket can be retried
        await runRegistry.unregister(ticketKey).catch(() => {});
        logger.warn({ ticketKey, runId }, "poll_cleaned_unreachable_run");
        cleaned++;
      }
      continue;
    }

    // Ticket left the AI column — cancel and unregister
    try {
      const run = getRun(runId);
      await run.cancel();
      await runRegistry.unregister(ticketKey);
      logger.info({ ticketKey, runId }, "poll_cancelled_stale_run");
      cancelled++;
    } catch (err) {
      // Run may already be finished — unregister to clean up
      await runRegistry.unregister(ticketKey).catch(() => {});
      logger.warn(
        { ticketKey, runId, error: (err as Error).message },
        "poll_stale_run_cleanup_error",
      );
    }
  }

  return { status: "ok", discovered: ticketKeys.length, started: started.length, cancelled, cleaned };
});
