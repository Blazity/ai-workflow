import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import type { TicketRunsResponse } from "@shared/contracts";
import {
  listTicketRuns,
  ticketKeyFromPathSegment,
} from "../../../../services/tickets/ticket-runs-read.js";

export default defineEventHandler(async (event): Promise<TicketRunsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  const ticketKey = ticketKeyFromPathSegment(getRouterParam(event, "ticketKey"));
  return { generatedAt, ...(await listTicketRuns(ticketKey)) };
});
