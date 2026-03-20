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

    // Skip if a workflow is already running for this ticket
    const existingRunId = await runRegistry.getRunId(key);
    if (existingRunId) {
      logger.info({ ticketKey: key, runId: existingRunId }, "poll_ticket_already_running");
      continue;
    }

    try {
      const ticket = await issueTracker.fetchTicket(key);
      const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
      const existingPR = await vcs.findPR(branchName);

      if (existingPR) {
        const handle = await start(reviewFixWorkflow, [ticket.id, branchName]);
        await runRegistry.register(ticket.identifier, handle.runId).catch((err) =>
          logger.warn({ ticketKey: key, runId: handle.runId, error: (err as Error).message }, "poll_register_failed"),
        );
        logger.info(
          { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
          "workflow_started_review_fix",
        );
      } else {
        const handle = await start(implementationWorkflow, [ticket.id]);
        await runRegistry.register(ticket.identifier, handle.runId).catch((err) =>
          logger.warn({ ticketKey: key, runId: handle.runId, error: (err as Error).message }, "poll_register_failed"),
        );
        logger.info(
          { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
          "workflow_started_implementation",
        );
      }

      started.push(ticket.identifier);
    } catch (err) {
      logger.warn(
        { ticketKey: key, error: (err as Error).message },
        "poll_ticket_dispatch_error",
      );
    }
  }

  // Cancel runs for tickets that have been moved out of the AI column
  const aiColumnSet = new Set(ticketKeys);
  const activeRuns = await runRegistry.listAll();
  let cancelled = 0;

  for (const { ticketKey, runId } of activeRuns) {
    if (aiColumnSet.has(ticketKey)) continue; // still in AI column

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

  return { status: "ok", discovered: ticketKeys.length, started: started.length, cancelled };
});
