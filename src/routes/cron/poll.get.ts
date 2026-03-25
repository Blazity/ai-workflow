import { defineEventHandler, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { reconcileRuns } from "../../lib/reconcile.js";
import { logger } from "../../lib/logger.js";

export default defineEventHandler(async (event) => {
  if (env.CRON_SECRET) {
    const auth = getHeader(event, "authorization");
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
  }

  const adapters = createAdapters();

  const jql = `project = ${env.JIRA_PROJECT_KEY} AND status = "${env.COLUMN_AI}"`;
  const ticketKeys = await adapters.issueTracker.searchTickets(jql);

  logger.info({ ticketCount: ticketKeys.length }, "poll_discovered_tickets");

  // Dispatch new tickets
  const started: string[] = [];
  for (const key of ticketKeys) {
    const result = await dispatchTicket(key, adapters, env.MAX_CONCURRENT_AGENTS);
    if (result.started) started.push(key);
    if (result.reason === "at_capacity") break;
  }

  // Reconcile stale/dead runs
  const { cancelled, cleaned } = await reconcileRuns(
    new Set(ticketKeys),
    adapters.runRegistry,
  );

  return {
    status: "ok",
    discovered: ticketKeys.length,
    started: started.length,
    cancelled,
    cleaned,
  };
});
