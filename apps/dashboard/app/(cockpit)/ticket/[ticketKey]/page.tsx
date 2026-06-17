// apps/dashboard/app/(cockpit)/ticket/[ticketKey]/page.tsx — Ticket runs ("/ticket/<key>")
import { Suspense } from "react";

import { TicketData } from "@/app/ticket-data";
import { TicketSkeleton } from "@/app/ticket-skeleton";

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
  // Key on the ticket only: switching the selected run (`?run=`) re-renders in
  // place (no skeleton flash), same trick /runs uses for `q`.
  return (
    <Suspense key={ticketKey} fallback={<TicketSkeleton />}>
      <TicketData ticketKey={ticketKey} run={run} />
    </Suspense>
  );
}
