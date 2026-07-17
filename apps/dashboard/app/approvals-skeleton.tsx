function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function ApprovalsSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Block className="h-10 w-48" />
        <Block className="h-8 w-44" />
      </div>
      <Block className="h-[480px]" />
    </div>
  );
}
