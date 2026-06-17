// apps/dashboard/app/ticket-data.tsx
import { getJSON } from "@/lib/api/server";
import { TicketScreen } from "@/components/cockpit/screens/ticket";
import { TicketMobileScreen } from "@/components/cockpit/mobile/screens/ticket-mobile";
import type { TicketRunsResponse, RunDetailResponse } from "@shared/contracts";
import { ticketRunsFallback, runDetailFallback } from "@/lib/api/fallbacks";
import { pickSelectedRunId } from "@/lib/ticket";

export async function TicketData({
  ticketKey,
  run,
}: {
  ticketKey: string;
  run?: string;
}) {
  const now = new Date().toISOString();
  const data = await getJSON<TicketRunsResponse>(
    `/api/v1/tickets/${encodeURIComponent(ticketKey)}`,
  ).catch(() => ticketRunsFallback(now));

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
        <TicketMobileScreen ticketKey={ticketKey} data={data} />
      </div>
    </>
  );
}
