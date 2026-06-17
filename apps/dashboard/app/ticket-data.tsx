// apps/dashboard/app/ticket-data.tsx
import { getJSON } from "@/lib/api/server";
import { TicketScreen } from "@/components/cockpit/screens/ticket";
import { TicketMobileScreen } from "@/components/cockpit/mobile/screens/ticket-mobile";
import type {
  TicketRunsResponse,
  RunDetailResponse,
  LiveRunsResponse,
} from "@shared/contracts";
import {
  ticketRunsFallback,
  runDetailFallback,
  liveRunsFallback,
} from "@/lib/api/fallbacks";
import { pickSelectedRunId, mergeTicketLiveRuns } from "@/lib/ticket";

export async function TicketData({
  ticketKey,
  run,
}: {
  ticketKey: string;
  run?: string;
}) {
  const now = new Date().toISOString();
  // The ticket store (workflow_runs) only holds historical/completed runs; in-flight
  // running/awaiting runs live in the registry, exposed via /api/v1/runs/live — fetch
  // both and merge the live runs for this ticket, mirroring the /runs screen.
  const [stored, live] = await Promise.all([
    getJSON<TicketRunsResponse>(
      `/api/v1/tickets/${encodeURIComponent(ticketKey)}`,
    ).catch(() => ticketRunsFallback(now)),
    getJSON<LiveRunsResponse>("/api/v1/runs/live").catch(() =>
      liveRunsFallback(now),
    ),
  ]);
  const data = mergeTicketLiveRuns(
    stored,
    live.rows.filter((r) => r.ticket === ticketKey),
  );

  const selectedRunId = pickSelectedRunId(data.runs, run);
  const detail: RunDetailResponse = selectedRunId
    ? await getJSON<RunDetailResponse>(
        `/api/v1/runs/${encodeURIComponent(selectedRunId)}`,
      ).catch(() => runDetailFallback(now))
    : runDetailFallback(now);

  return (
    <>
      <div className="hidden lg:block">
        <TicketScreen
          ticketKey={ticketKey}
          data={data}
          detail={detail}
          selectedRunId={selectedRunId}
        />
      </div>
      <div className="lg:hidden">
        <TicketMobileScreen
          ticketKey={ticketKey}
          data={data}
          detail={detail}
          selectedRunId={selectedRunId}
          run={run}
        />
      </div>
    </>
  );
}
