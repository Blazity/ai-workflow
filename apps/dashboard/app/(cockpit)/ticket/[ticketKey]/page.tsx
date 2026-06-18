// apps/dashboard/app/(cockpit)/ticket/[ticketKey]/page.tsx — Ticket runs ("/ticket/<key>")
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
import { MobileBackToRuns } from "@/components/cockpit/mobile/screens/ticket-mobile";
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
  // by the desktop split view and the mobile inline view — getRunDetail()
  // dedupes the fetch.
  const detail = (
    <Suspense key={`detail:${run ?? "default"}`} fallback={<TraceDetailSkeleton />}>
      <RunDetailData ticketKey={ticketKey} run={run} />
    </Suspense>
  );

  return (
    <TicketSelectionProvider ticketKey={ticketKey}>
      {/* Desktop: master/detail split (rail+header | trace), independent boundaries.
          DetailArea shows the skeleton itself while a run switch is pending. */}
      <div
        className="hidden lg:grid h-full min-h-0"
        style={{
          gridTemplateColumns: "280px 1fr",
          gridTemplateRows: "auto minmax(0, 1fr)",
          gridTemplateAreas: '"header header" "rail detail"',
        }}
      >
        <Suspense key={`shell:${ticketKey}`} fallback={<TicketShellSkeleton />}>
          <TicketShellData ticketKey={ticketKey} />
        </Suspense>
        <DetailArea>{detail}</DetailArea>
      </div>

      {/* Mobile: one view at a time — a run's trace (with a way back) or the list. */}
      <div className="lg:hidden">
        {run ? (
          <div className="flex flex-col gap-3 px-4 pt-4 pb-6">
            <MobileBackToRuns ticketKey={ticketKey} />
            {detail}
          </div>
        ) : (
          <Suspense key={`mlist:${ticketKey}`} fallback={<TicketMobileSkeleton />}>
            <TicketMobileListData ticketKey={ticketKey} />
          </Suspense>
        )}
      </div>
    </TicketSelectionProvider>
  );
}
