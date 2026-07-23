// apps/dashboard/app/ticket-data.tsx
import { TicketScreen } from "@/components/cockpit/screens/ticket";
import { TicketMobileScreen } from "@/components/cockpit/mobile/screens/ticket-mobile";
import { TraceDetail } from "@/components/cockpit/screens/trace";
import { CkCard } from "@/components/ui";
import {
  getTicketRuns,
  getRunDetail,
  getRunReplay,
} from "@/lib/api/ticket-runs";
import { pickSelectedRunId } from "@/lib/ticket";

/** Header rollup + runs rail (desktop). Depends only on the ticket, not `?run=`. */
export async function TicketShellData({ ticketKey }: { ticketKey: string }) {
  const data = await getTicketRuns(ticketKey);
  return <TicketScreen ticketKey={ticketKey} data={data} />;
}

/** Mobile run list. Same data as the desktop shell, list-only layout. */
export async function TicketMobileListData({
  ticketKey,
}: {
  ticketKey: string;
}) {
  const data = await getTicketRuns(ticketKey);
  return <TicketMobileScreen ticketKey={ticketKey} data={data} />;
}

/**
 * The selected run's trace — its own Suspense boundary so switching runs streams
 * a fresh skeleton without touching the rail. When a run is named in the URL
 * (a rail click / deep link) we fetch it directly and never block on the runs
 * list; only the default (newest) run needs the list, on first load of
 * `/ticket/<key>`. An unknown `?run=` resolves to the worker's "unavailable"
 * trace rather than silently falling back to the newest run.
 */
export async function RunDetailData({
  ticketKey,
  run,
}: {
  ticketKey: string;
  run?: string;
}) {
  let runId = run ?? null;
  if (!runId) {
    const data = await getTicketRuns(ticketKey);
    runId = pickSelectedRunId(data.runs, undefined);
  }
  if (!runId) {
    return (
      <CkCard eyebrow="Run trace" title="No runs">
        <div className="py-6 text-center text-neutral-500 font-body text-[13px]">
          No runs recorded for {ticketKey}.
        </div>
      </CkCard>
    );
  }
  const [detail, replay] = await Promise.all([
    getRunDetail(runId),
    getRunReplay(runId),
  ]);
  return <TraceDetail runId={runId} data={detail} replay={replay} />;
}
