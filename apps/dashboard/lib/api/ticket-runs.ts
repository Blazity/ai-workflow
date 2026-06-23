// apps/dashboard/lib/api/ticket-runs.ts
import { cache } from "react";
import { getJSON, authAwareFallback } from "./server";
import type {
  TicketRunsResponse,
  RunDetailResponse,
  LiveRunsResponse,
} from "@shared/contracts";
import {
  ticketRunsFallback,
  runDetailFallback,
  liveRunsFallback,
} from "./fallbacks";
import { mergeTicketLiveRuns } from "@/lib/ticket";

/**
 * Ticket runs list — header rollup + the runs rail — with in-flight
 * (running/awaiting) runs merged in from the registry. Wrapped in React
 * `cache()` so the rail shell and the detail boundary's default-run resolution
 * share a single fetch within one server render. `cache()` is per-request, so
 * every navigation / `router.refresh()` still fetches fresh — it only dedupes
 * within a single render pass, never across loads.
 */
export const getTicketRuns = cache(
  async (ticketKey: string): Promise<TicketRunsResponse> => {
    const now = new Date().toISOString();
    const [stored, live] = await Promise.all([
      getJSON<TicketRunsResponse>(
        `/api/v1/tickets/${encodeURIComponent(ticketKey)}`,
      ).catch((e) => authAwareFallback(e, () => ticketRunsFallback(now))),
      getJSON<LiveRunsResponse>("/api/v1/runs/live").catch((e) =>
        authAwareFallback(e, () => liveRunsFallback(now)),
      ),
    ]);
    return mergeTicketLiveRuns(
      stored,
      live.rows.filter((r) => r.ticket === ticketKey),
    );
  },
);

/**
 * A single run's trace detail. Cached per request so the desktop split view and
 * the mobile inline view — both mounted, one hidden by CSS — share one fetch.
 */
export const getRunDetail = cache(
  async (runId: string): Promise<RunDetailResponse> => {
    const now = new Date().toISOString();
    return getJSON<RunDetailResponse>(
      `/api/v1/runs/${encodeURIComponent(runId)}`,
    ).catch((e) => authAwareFallback(e, () => runDetailFallback(now)));
  },
);
