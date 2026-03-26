import { defineEventHandler, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { reconcileRuns } from "../../lib/reconcile.js";
import { logger } from "../../lib/logger.js";

export default defineEventHandler(async (event) => {
  verifyCronAuth(getHeader(event, "authorization"));

  const adapters = createAdapters();
  const ticketKeys = await discoverAiColumnTickets(adapters);
  const started = await dispatchDiscoveredTickets(ticketKeys, adapters);
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

function verifyCronAuth(authHeader: string | undefined): void {
  if (!env.CRON_SECRET) return;
  if (authHeader === `Bearer ${env.CRON_SECRET}`) return;

  throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
}

async function discoverAiColumnTickets(
  adapters: ReturnType<typeof createAdapters>,
): Promise<string[]> {
  const jql = `project = ${env.JIRA_PROJECT_KEY} AND status = "${env.COLUMN_AI}"`;
  const ticketKeys = await adapters.issueTracker.searchTickets(jql);
  logger.info({ ticketCount: ticketKeys.length }, "poll_discovered_tickets");
  return ticketKeys;
}

async function dispatchDiscoveredTickets(
  ticketKeys: string[],
  adapters: ReturnType<typeof createAdapters>,
): Promise<string[]> {
  const started: string[] = [];

  for (const key of ticketKeys) {
    const result = await dispatchTicket(key, adapters, env.MAX_CONCURRENT_AGENTS);
    if (result.started) started.push(key);
    if (result.reason === "at_capacity") break;
  }

  return started;
}
