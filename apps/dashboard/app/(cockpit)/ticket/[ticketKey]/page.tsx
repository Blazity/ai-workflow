// apps/dashboard/app/(cockpit)/ticket/[ticketKey]/page.tsx: Ticket runs ("/ticket/<key>")
import { Suspense } from "react";

import {
  TicketShellData,
  TicketMobileListData,
  RunDetailData,
} from "@/app/ticket-data";
import {
  TicketShellSkeleton,
  TraceDetailSkeleton,
  TicketMobileSkeleton,
} from "@/app/ticket-skeleton";
import {
  TicketSelectionProvider,
  DetailArea,
} from "@/components/cockpit/screens/ticket-selection";

export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketKey: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { ticketKey: raw } = await params;
  const ticketKey = decodeURIComponent(raw);
  const sp = await searchParams;
  const run = typeof sp.run === "string" ? sp.run : undefined;

  // The trace lives in its own boundary, keyed on the run: switching runs swaps
  // the key, so React streams a fresh skeleton here instead of blocking the
  // whole page. The rail/header (shell) is a separate boundary keyed on the
  // ticket, so picking a run never refetches or blocks it. Reused (CSS-toggled)
  // by the desktop split view and the mobile inline view, getRunDetail()
  // dedupes the fetch.
  const detail = (
    <Suspense key={`detail:${run ?? "default"}`} fallback={<TraceDetailSkeleton />}>
      <RunDetailData ticketKey={ticketKey} run={run} />
    </Suspense>
  );

  const shell = (
    <Suspense key={`shell:${ticketKey}`} fallback={<TicketShellSkeleton />}>
      <TicketShellData ticketKey={ticketKey} />
    </Suspense>
  );

  return (
    <TicketSelectionProvider ticketKey={ticketKey}>
      {run ? (
        /* A run is named, and both layouts show that run's trace. ONE tree
           carries it: a grid from `lg` (rail and header beside the trace) and
           a plain column below (the trace alone, with its own way back). The
           chrome that differs is hidden by CSS; the trace itself is mounted
           once, because a second copy would fetch, poll and cache everything
           again behind `display: none`. Crossing the breakpoint restyles this
           tree rather than replacing it, so an open section, the scroll
           position and every poll survive a resize or a rotation. */
        <div
          className="lg:grid lg:h-full lg:min-h-0"
          style={{
            gridTemplateColumns: "280px minmax(0, 1fr)",
            gridTemplateRows: "auto minmax(0, 1fr)",
            gridTemplateAreas: '"header header" "rail detail"',
          }}
        >
          {/* `contents` so the header and rail keep their own grid areas. */}
          <div className="hidden lg:contents">{shell}</div>
          <DetailArea>{detail}</DetailArea>
        </div>
      ) : (
        /* No run named: the two widths show different things, not the same
           thing twice. The desktop opens the newest run's trace beside the
           rail; a phone shows the runs list and no trace at all. */
        <>
          <div
            className="hidden lg:grid h-full min-h-0"
            style={{
              gridTemplateColumns: "280px minmax(0, 1fr)",
              gridTemplateRows: "auto minmax(0, 1fr)",
              gridTemplateAreas: '"header header" "rail detail"',
            }}
          >
            {shell}
            <DetailArea>{detail}</DetailArea>
          </div>
          <div className="lg:hidden">
            <Suspense key={`mlist:${ticketKey}`} fallback={<TicketMobileSkeleton />}>
              <TicketMobileListData ticketKey={ticketKey} />
            </Suspense>
          </div>
        </>
      )}
    </TicketSelectionProvider>
  );
}
