// apps/dashboard/app/overview-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function OverviewSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-5">
      {/* Hero KPIs */}
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Block key={i} className="h-[124px]" />
        ))}
      </div>
      {/* Live row */}
      <div className="grid grid-cols-2 gap-3">
        <Block className="h-[220px]" />
        <Block className="h-[220px]" />
      </div>
      {/* Recent runs */}
      <Block className="h-[360px]" />
      {/* Workflows */}
      <Block className="h-[260px]" />
    </div>
  );
}
