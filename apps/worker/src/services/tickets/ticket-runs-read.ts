/**
 * Every run this system has made for one ticket, as the ticket page reads it.
 *
 * The path segment arrives percent-encoded and client-supplied, so what counts
 * as a ticket key at all is decided here: anything longer than a key the
 * trackers issue is truncated rather than sent to the database, and a blank one
 * names no ticket, which is the empty state and not an error.
 */
import type { TicketRunsResponse } from "@shared/contracts";
import { getDb } from "../../db/client.js";
import { listRunsForTicket } from "../../db/repositories/runs.js";
import { logger } from "../../infra/logger.js";
import { issueTrackerBaseUrl } from "../settings/index.js";

/** The ticket payload as the wire carries it, minus the timestamp the route stamps. */
export type TicketRunsPayload = Omit<TicketRunsResponse, "generatedAt">;

const EMPTY: TicketRunsPayload = {
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

/** Longer than any key a tracker issues, so the remainder is not part of one. */
const MAX_TICKET_KEY_LENGTH = 100;

/** The ticket key a raw path segment names, empty when it names none. */
export function ticketKeyFromPathSegment(raw: string | undefined): string {
  return raw ? decodeURIComponent(raw).trim().slice(0, MAX_TICKET_KEY_LENGTH) : "";
}

export async function listTicketRuns(ticketKey: string): Promise<TicketRunsPayload> {
  if (!ticketKey) return EMPTY;
  try {
    const { ticket, runs, totals } = await listRunsForTicket({
      db: getDb(),
      ticketKey,
      now: new Date(),
      jiraBaseUrl: issueTrackerBaseUrl(),
    });
    return { available: true, ticket, runs, totals };
  } catch (err) {
    // DB unreachable: degrade to the empty state so the page renders its
    // documented N/A view instead of erroring.
    logger.warn({ err: (err as Error).message, ticketKey }, "ticket_runs_failed");
    return EMPTY;
  }
}
