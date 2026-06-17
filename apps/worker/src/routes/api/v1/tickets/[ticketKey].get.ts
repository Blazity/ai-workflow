import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import type { TicketRunsResponse } from "@shared/contracts";
import { env } from "../../../../../env.js";
import { getDb } from "../../../../db/client.js";
import { listRunsForTicket } from "../../../../db/queries/runs-read.js";
import { logger } from "../../../../lib/logger.js";

const EMPTY: Omit<TicketRunsResponse, "generatedAt"> = {
  available: false,
  ticket: null,
  runs: [],
  totals: {
    cost: 0,
    tokens: 0,
    runCount: 0,
    counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
  },
};

export default defineEventHandler(async (event): Promise<TicketRunsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  const raw = getRouterParam(event, "ticketKey");
  const ticketKey = raw ? decodeURIComponent(raw).trim().slice(0, 100) : "";
  if (!ticketKey) return { generatedAt, ...EMPTY };

  try {
    const model =
      env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
    const { ticket, runs, totals } = await listRunsForTicket({
      db: getDb(),
      ticketKey,
      now: new Date(),
      jiraBaseUrl: env.JIRA_BASE_URL,
      modelFallback: model,
    });
    return { generatedAt, available: true, ticket, runs, totals };
  } catch (err) {
    logger.warn({ err: (err as Error).message, ticketKey }, "ticket_runs_failed");
    return { generatedAt, ...EMPTY };
  }
});
