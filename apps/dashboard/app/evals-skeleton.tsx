// apps/dashboard/app/evals-skeleton.tsx
import { Block } from "./skeleton-block";

export function EvalsSkeleton() {
  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      {/* Header (eyebrow + title, chip) */}
      <div className="flex items-center justify-between">
        <Block className="h-10 w-72" />
        <Block className="h-8 w-64" />
      </div>
      {/* Quality group card */}
      <Block className="h-[200px]" />
    </div>
  );
}
