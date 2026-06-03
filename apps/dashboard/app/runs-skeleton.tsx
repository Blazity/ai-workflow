// apps/dashboard/app/runs-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function RunsSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      {/* Header (title + tabs/buttons) */}
      <div className="flex items-center justify-between">
        <Block className="h-10 w-48" />
        <Block className="h-8 w-80" />
      </div>
      {/* Runs table */}
      <Block className="h-[480px]" />
    </div>
  );
}
