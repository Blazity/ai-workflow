// apps/dashboard/app/ticket-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

/** Desktop shell fallback — fills the `header` and `rail` grid areas. */
export function TicketShellSkeleton() {
  return (
    <>
      <div
        style={{ gridArea: "header" }}
        className="flex flex-col gap-2 px-6 pt-5 pb-4 border-b border-neutral-200 bg-app-bg"
      >
        <Block className="h-4 w-40" />
        <Block className="h-8 w-[28rem]" />
        <Block className="h-5 w-72" />
      </div>
      <div
        style={{ gridArea: "rail" }}
        className="border-r border-neutral-200 bg-panel overflow-hidden flex flex-col gap-2 p-4"
      >
        <Block className="h-16" />
        <Block className="h-16" />
        <Block className="h-16" />
        <Block className="h-16" />
      </div>
    </>
  );
}

/** Right-panel fallback shown while a run's trace streams in (matches the
 *  trace's header + KPI row + timeline). The detail container owns the padding. */
export function TraceDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Block className="h-7 w-96" />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <Block className="h-16" />
        <Block className="h-16" />
        <Block className="h-16" />
        <Block className="h-16" />
        <Block className="h-16" />
      </div>
      <Block className="h-[320px]" />
    </div>
  );
}

/** Mobile run-list fallback. */
export function TicketMobileSkeleton() {
  return (
    <div className="px-4 pt-4 pb-6 flex flex-col gap-3">
      <Block className="h-3 w-24" />
      <Block className="h-7 w-64" />
      <Block className="h-4 w-48" />
      <div className="flex flex-col gap-2.5 mt-1">
        <Block className="h-28" />
        <Block className="h-28" />
        <Block className="h-28" />
      </div>
    </div>
  );
}
