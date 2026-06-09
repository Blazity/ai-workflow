// apps/dashboard/app/skeleton-block.tsx
export function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}
