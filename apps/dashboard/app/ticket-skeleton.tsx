// apps/dashboard/app/ticket-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function TicketSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      {/* Rollup header */}
      <Block className="h-4 w-40" />
      <Block className="h-9 w-[28rem]" />
      <Block className="h-5 w-72" />
      {/* Split: rail + detail */}
      <div className="grid grid-cols-[260px_1fr] gap-4">
        <div className="flex flex-col gap-2">
          <Block className="h-16" />
          <Block className="h-16" />
          <Block className="h-16" />
        </div>
        <Block className="h-[420px]" />
      </div>
    </div>
  );
}
