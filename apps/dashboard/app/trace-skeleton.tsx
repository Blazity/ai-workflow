// apps/dashboard/app/trace-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function TraceSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      {/* Breadcrumb + header */}
      <Block className="h-4 w-40" />
      <Block className="h-9 w-96" />
      {/* KPI row */}
      <div className="grid grid-cols-4 gap-2">
        <Block className="h-16" />
        <Block className="h-16" />
        <Block className="h-16" />
        <Block className="h-16" />
      </div>
      {/* Timeline */}
      <Block className="h-[320px]" />
    </div>
  );
}
