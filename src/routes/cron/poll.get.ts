import { defineEventHandler, getHeader, createError } from "h3";
import { getRun } from "workflow/api";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { logger } from "../../lib/logger.js";

export default defineEventHandler(async (event) => {
  if (env.CRON_SECRET) {
    const auth = getHeader(event, "authorization");
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
  }

  const adapters = createAdapters();
  const { issueTracker, runRegistry } = adapters;

  const jql = `project = ${env.JIRA_PROJECT_KEY} AND status = "${env.COLUMN_AI}"`;
  const ticketKeys = await issueTracker.searchTickets(jql);

  logger.info({ ticketCount: ticketKeys.length }, "poll_discovered_tickets");

  const started: string[] = [];
  for (const key of ticketKeys) {
    const result = await dispatchTicket(
      key,
      adapters,
      env.MAX_CONCURRENT_AGENTS,
    );
    if (result.started) {
      started.push(key);
    }
    if (result.reason === "at_capacity") {
      break;
    }
  }

  // Reconcile registry: cancel stale runs and clean up dead entries
  const aiColumnSet = new Set(ticketKeys);
  const activeRuns = await runRegistry.listAll();
  let cancelled = 0;
  let cleaned = 0;

  for (const { ticketKey, runId } of activeRuns) {
    if (aiColumnSet.has(ticketKey)) {
      try {
        const run = getRun(runId);
        const status = await run.status;
        if (
          status === "completed" ||
          status === "failed" ||
          status === "cancelled"
        ) {
          await runRegistry.unregister(ticketKey);
          logger.info({ ticketKey, runId, status }, "poll_cleaned_dead_run");
          cleaned++;
        }
      } catch {
        await runRegistry.unregister(ticketKey).catch(() => {});
        logger.warn({ ticketKey, runId }, "poll_cleaned_unreachable_run");
        cleaned++;
      }
      continue;
    }

    try {
      const run = getRun(runId);
      await run.cancel();
      await runRegistry.unregister(ticketKey);
      logger.info({ ticketKey, runId }, "poll_cancelled_stale_run");
      cancelled++;
    } catch (err) {
      await runRegistry.unregister(ticketKey).catch(() => {});
      logger.warn(
        { ticketKey, runId, error: (err as Error).message },
        "poll_stale_run_cleanup_error",
      );
    }
  }

  return {
    status: "ok",
    discovered: ticketKeys.length,
    started: started.length,
    cancelled,
    cleaned,
  };
});
